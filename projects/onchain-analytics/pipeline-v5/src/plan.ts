/**
 * plan.ts -- say exactly what a run would do, without doing any of it.
 *
 * WHY THIS IS A MODE AND NOT A FLAG. `--dry-run` already exists on `dedup` and `repair`, and it
 * means "compute the change and do not apply it", which still reads the warehouse and still costs
 * a query. Plan task 9 asks for something stricter: a command that performs NO chain read and NO
 * BigQuery write, and returns the exact proposed work units and the budget verdict. That is the
 * command you run before an A5-shaped decision, on a laptop, with no credential.
 *
 * WHAT PURITY COSTS, STATED RATHER THAN HIDDEN. A `daily` unit's start block comes from the
 * coverage ledger and its end comes from the chain tip. Neither is knowable without reading
 * something, so in plan mode those ranges are UNRESOLVED, and a plan containing an unresolved
 * range is reported `incomplete` and exits nonzero. It is not rounded up to a guess and it is not
 * quietly reported as complete: the honest answer to "what exactly will this run read" is "I
 * cannot tell you without reading the ledger", and a plan that invented a number would be the
 * same defect class as a refusal that reports success.
 *
 * A plan with an explicit `--from` and `--to` is fully resolved and exits 0 when it fits the
 * budget, which is the case the plan-before-you-run workflow actually uses.
 */

import { NETWORKS, RAW_LOGS_TABLE, TRANSACTIONS_TABLE, selectedNetworks } from "./config.js";
import { RELEASE_SCOPE_FREEZE, type ReleaseScopeFreeze } from "./control-plane/releaseScope.js";
import { targetsFor } from "./registry.js";
import { readerFor } from "./reader.js";
import { checkCaptureSpan, checkRunSize, maxCaptureBlocks, type BudgetVerdict } from "./budget.js";
import { RunSummary, unit, planExitCode, PARENT_GRAIN, type PlanOutcome } from "./outcome.js";
import type { PipelineOpts, NetworkConfig } from "./types.js";

/** The two grains one capture writes. A refusal or a plan has to speak about both. */
const CAPTURE_GRAINS = [RAW_LOGS_TABLE, TRANSACTIONS_TABLE] as const;

export interface PlannedUnit {
  readonly chainId: number;
  readonly network: string;
  readonly address: string;
  readonly contractName: string;
  readonly grain: string;
  /** Null where the bound cannot be known without reading the ledger or the chain. */
  readonly fromBlock: number | null;
  readonly toBlock: number | null;
  readonly rangeResolved: boolean;
  /** Where each bound came from, specifically enough to check. */
  readonly rangeSource: string;
  /** The span verdict, present only where the range is resolved enough to judge. */
  readonly spanVerdict: BudgetVerdict | null;
}

export interface PlanReport {
  readonly outcome: PlanOutcome;
  readonly exitCode: number;
  readonly mode: string;
  readonly chains: string[];
  readonly contractsPlanned: number;
  readonly unitsPlanned: number;
  readonly runSize: BudgetVerdict | null;
  readonly units: PlannedUnit[];
  /** Every reason this plan is not `complete`, one sentence each. Empty when it is. */
  readonly refusals: string[];
  readonly summary: RunSummary;
}

/**
 * The chains this command may address at all.
 *
 * Read from the FROZEN RELEASE SCOPE, never from a list written here. Fuse was dropped from the
 * release on 2026-09-28 after the scope was first frozen, and a chain list copied into a second
 * file is exactly how a decision like that gets applied in one place and missed in another. The
 * freeze module is the single authority; when it changes, this follows with no edit.
 */
export function releaseScopeChains(freeze: ReleaseScopeFreeze = RELEASE_SCOPE_FREEZE): string[] {
  return [...freeze.releaseChains];
}

/** Configured, and inside the frozen release scope. Both conditions, separately reportable. */
function scopeVerdict(network: NetworkConfig, freeze: ReleaseScopeFreeze): { inScope: boolean; reason: string } {
  if (!freeze.frozen) return { inScope: true, reason: "release scope is not frozen" };
  if (releaseScopeChains(freeze).includes(network.name)) {
    return { inScope: true, reason: `in the release scope frozen on ${freeze.decidedOn}` };
  }
  return {
    inScope: false,
    reason:
      `${network.name} is configured but is NOT in the release scope frozen on ` +
      `${freeze.decidedOn} (${releaseScopeChains(freeze).join(", ")}); see ` +
      `${freeze.decisionRecord}`,
  };
}

/**
 * Build the plan. Pure: reads the control-plane seeds and the arguments, nothing else.
 *
 * No BigQuery client is constructed, no query is issued, no chain tip is fetched and no run row is
 * written. A test proves that by running this with every adapter unset.
 *
 * `freeze` is a parameter with the frozen module as its default, which is the same shape
 * `assertReleaseScopeFrozen` uses. It exists so a test can narrow the release scope and watch the
 * refusal happen, rather than asserting against whatever the scope happens to say today.
 */
export function buildPlan(
  opts: PipelineOpts,
  freeze: ReleaseScopeFreeze = RELEASE_SCOPE_FREEZE,
): PlanReport {
  const summary = new RunSummary();
  const units: PlannedUnit[] = [];
  const refusals: string[] = [];

  const networks = selectedNetworks(opts.chains);
  if (networks.length === 0) {
    const asked = opts.chains?.join(", ") ?? "(none)";
    const detail =
      `no configured chain matched --chains=${asked}; known chains are ` +
      `${Object.values(NETWORKS).map((n) => n.name).join(", ")}`;
    summary.add(unit("unsupported", PARENT_GRAIN, detail));
    return report("unsupported", opts, [], 0, null, units, [detail], summary);
  }

  const usable: NetworkConfig[] = [];
  for (const network of networks) {
    const scope = scopeVerdict(network, freeze);
    if (!scope.inScope) {
      refusals.push(scope.reason);
      summary.add(unit("unsupported", PARENT_GRAIN, scope.reason, { chainId: network.chainId }));
      continue;
    }
    const reader = readerFor(network);
    if (!network.ingestEnabled || reader.kind === "none") {
      const detail = `${network.name} has no adequate reader: ${network.disabledReason ?? reader.reason}`;
      refusals.push(detail);
      summary.add(unit("unsupported", PARENT_GRAIN, detail, { chainId: network.chainId }));
      continue;
    }
    usable.push(network);
  }

  const targets = usable.flatMap((n) =>
    targetsFor(n, { addresses: opts.addresses }).map((t) => ({ network: n, target: t })));

  if (targets.length === 0) {
    const filter = opts.addresses ? `--addresses=${opts.addresses.join(",")}` : "(no address filter)";
    const detail =
      `zero capture targets: no contract in the control plane matched ${filter} on ` +
      `${usable.map((n) => n.name).join(", ") || "any usable chain"}. Empty work is not success.`;
    refusals.push(detail);
    summary.add(unit("unsupported", PARENT_GRAIN, detail));
    return report("unsupported", opts, networks.map((n) => n.name), 0, null, units, refusals, summary);
  }

  const runSize = checkRunSize(targets.length, opts);
  if (!runSize.allowed) {
    refusals.push(runSize.reason ?? "the run-size budget refused this plan");
    for (const { network, target } of targets) {
      for (const grain of CAPTURE_GRAINS) {
        summary.plan(grain, 1);
        summary.add(unit(
          "refused_budget", grain,
          `${target.contractName} ${target.address} on ${network.name}: ${runSize.reason}`,
          { chainId: target.chainId, address: target.address },
        ));
      }
    }
    return report(
      "refused", opts, networks.map((n) => n.name), targets.length, runSize, units, refusals, summary);
  }

  let anyUnresolved = false;
  let anyRefusedSpan = false;

  for (const { network, target } of targets) {
    const fromBlock = opts.fromBlock ?? (opts.mode === "backfill" ? target.firstBlock : null);
    const toBlock = opts.toBlock ?? null;
    const rangeResolved = fromBlock !== null && toBlock !== null;

    const rangeSource = [
      opts.fromBlock !== undefined
        ? `start from --from=${opts.fromBlock}`
        : opts.mode === "backfill"
          ? `start from the contract's creation block ${target.firstBlock}`
          : "start from the coverage frontier, which plan mode does not read",
      opts.toBlock !== undefined
        ? `end at --to=${opts.toBlock}`
        : `end at the chain tip minus ${network.finality.blocks} finality block(s), which plan mode does not read`,
    ].join("; ");

    const spanVerdict = rangeResolved
      ? checkCaptureSpan(network, fromBlock!, toBlock!, opts)
      : null;

    if (!rangeResolved) anyUnresolved = true;
    if (spanVerdict && !spanVerdict.allowed) {
      anyRefusedSpan = true;
      refusals.push(spanVerdict.reason ?? "");
    }

    for (const grain of CAPTURE_GRAINS) {
      summary.plan(grain, 1);
      units.push({
        chainId: target.chainId, network: network.name,
        address: target.address, contractName: target.contractName,
        grain, fromBlock, toBlock, rangeResolved, rangeSource, spanVerdict,
      });

      if (spanVerdict && !spanVerdict.allowed) {
        summary.add(unit("refused_budget", grain, spanVerdict.reason ?? "", {
          chainId: target.chainId, address: target.address, fromBlock, toBlock,
        }));
      } else if (!rangeResolved) {
        summary.add(unit(
          "incomplete", grain,
          `${target.contractName} on ${network.name}: ${rangeSource}`,
          { chainId: target.chainId, address: target.address, fromBlock, toBlock },
        ));
      } else {
        summary.add(unit(
          "completed", grain,
          `${target.contractName} on ${network.name}: blocks ${fromBlock}..${toBlock} is ` +
          `${(toBlock! - fromBlock! + 1).toLocaleString()} block(s), inside the limit of ` +
          `${maxCaptureBlocks(network, opts).toLocaleString()}`,
          { chainId: target.chainId, address: target.address, fromBlock, toBlock },
        ));
      }
    }
  }

  if (anyRefusedSpan) {
    return report("refused", opts, networks.map((n) => n.name), targets.length, runSize, units, refusals, summary);
  }
  if (anyUnresolved) {
    refusals.push(
      `this plan is INCOMPLETE: at least one unit's block range cannot be resolved without reading ` +
      `the coverage ledger or the chain tip, and plan mode does neither. Supply --from and --to for ` +
      `an exact plan.`
    );
    return report("incomplete", opts, networks.map((n) => n.name), targets.length, runSize, units, refusals, summary);
  }
  return report("complete", opts, networks.map((n) => n.name), targets.length, runSize, units, refusals, summary);
}

function report(
  outcome: PlanOutcome,
  opts: PipelineOpts,
  chains: string[],
  contractsPlanned: number,
  runSize: BudgetVerdict | null,
  units: PlannedUnit[],
  refusals: string[],
  summary: RunSummary,
): PlanReport {
  return {
    outcome,
    exitCode: planExitCode(outcome),
    mode: opts.mode,
    chains,
    contractsPlanned,
    unitsPlanned: summary.totals.planned,
    runSize,
    units,
    refusals,
    summary,
  };
}

/** Human-readable rendering for the console. The JSON body is the machine-readable one. */
export function renderPlan(plan: PlanReport, freeze: ReleaseScopeFreeze = RELEASE_SCOPE_FREEZE): string {
  const lines: string[] = [];
  lines.push(`PLAN (${plan.mode}): ${plan.outcome.toUpperCase()}, exit ${plan.exitCode}`);
  lines.push(
    `  chains selected: ${plan.chains.join(", ") || "(none)"}; release scope is ` +
    `${releaseScopeChains(freeze).join(", ")} frozen ${freeze.decidedOn}`);
  lines.push(`  contracts planned: ${plan.contractsPlanned}; work units planned: ${plan.unitsPlanned}`);
  if (plan.runSize) {
    lines.push(
      `  run-size budget: ${plan.runSize.requested} requested against a limit of ` +
      `${plan.runSize.limit}, ${plan.runSize.allowed ? "allowed" : "REFUSED"}`);
  }
  const t = plan.summary.totals;
  lines.push(
    `  units: ${t.completed} resolved and inside budget, ${t.incomplete} unresolved, ` +
    `${t.refused} refused, ${t.unsupported} unsupported`);
  for (const [grain, c] of [...plan.summary.byGrain.entries()].sort()) {
    lines.push(`    ${grain}: planned ${c.planned}, resolved ${c.completed}, unresolved ${c.incomplete}, refused ${c.refused}`);
  }
  for (const u of plan.units.slice(0, 40)) {
    lines.push(
      `  - ${u.network} ${u.contractName} ${u.address} [${u.grain}] ` +
      `${u.rangeResolved ? `${u.fromBlock}..${u.toBlock}` : "UNRESOLVED"} (${u.rangeSource})`);
  }
  if (plan.units.length > 40) lines.push(`  ... ${plan.units.length - 40} more unit(s)`);
  for (const r of plan.refusals) lines.push(`  ! ${r}`);
  return lines.join("\n");
}
