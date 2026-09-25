/**
 * calibrate.ts
 *
 * Measure each source's false-zero rate in session, on the range shape actually being used.
 *
 * Why this exists rather than a fixed retry count. The stop rule this project relied on was
 * "stop when two consecutive passes add nothing." It fired falsely twice on one range. Raising
 * it to five was considered and rejected, and the arithmetic is the reason:
 *
 *   If one pass misses an outstanding item with probability p, k consecutive zero-gain passes
 *   occur falsely with probability p^k when one item is outstanding. The identical query on the
 *   identical endpoint measured p = 0.30 one day and p = 0.70 the next. At 0.70 a five-pass
 *   rule stops falsely one time in six.
 *
 * So a fixed pass count bounds nothing, because p is not a constant. What CAN be done is to
 * measure p now, on this endpoint, at this range size, and either choose k from it or conclude
 * the source is unusable and say so. A calibration that finds p = 0 on n repeats is a fact
 * about this session, reported with n, not a property of the source.
 *
 * The result is advisory. The pipeline itself never relies on repetition: it refuses short
 * collections outright and confirms every empty range on an independent source, which is a
 * cross-check rather than a bet on how many tries is enough.
 */

import { CONFIG, selectedNetworks } from "./config.js";
import { log } from "./log.js";
import { fetchRange, readerFor } from "./reader.js";
import { probeLogsPresent } from "./rpc.js";
import { targetsFor } from "./registry.js";
import type { PipelineOpts, NetworkConfig } from "./types.js";

export interface Calibration {
  source: string;
  network: string;
  fromBlock: number;
  toBlock: number;
  repeats: number;
  answers: number[];
  errors: number;
  modeAnswer: number | null;
  zeroAnswers: number;
  shortAnswers: number;
  /** Measured miss rate. A pass that returns fewer than the modal answer counts as a miss. */
  p: number;
  /** Passes needed for a false-stop probability under one percent at the measured p. */
  kForOnePercent: number | null;
  verdict: string;
}

function summarise(
  source: string,
  network: string,
  fromBlock: number,
  toBlock: number,
  answers: number[],
  errors: number
): Calibration {
  const counts = new Map<number, number>();
  for (const a of answers) counts.set(a, (counts.get(a) ?? 0) + 1);
  const modeAnswer = answers.length
    ? [...counts.entries()].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0][0]
    : null;

  const zeroAnswers = answers.filter((a) => a === 0).length;
  const shortAnswers = modeAnswer === null ? 0 : answers.filter((a) => a < modeAnswer).length;
  const p = answers.length === 0 ? 1 : shortAnswers / answers.length;

  let kForOnePercent: number | null = null;
  if (p === 0) kForOnePercent = 1;
  else if (p >= 1) kForOnePercent = null;
  else kForOnePercent = Math.ceil(Math.log(0.01) / Math.log(p));

  const verdict =
    answers.length === 0
      ? "UNUSABLE: no pass returned an answer"
      : p === 0
        ? `no short answer in ${answers.length} repeats. That is a fact about this session, not a property of the source`
        : `SHORT ON ${shortAnswers} OF ${answers.length}. A repetition-based stop rule needs k=${kForOnePercent ?? "unbounded"} here, and p moved by more than double within 24 hours last time it was measured`;

  return {
    source, network, fromBlock, toBlock,
    repeats: answers.length + errors, answers, errors,
    modeAnswer, zeroAnswers, shortAnswers, p, kForOnePercent, verdict,
  };
}

async function calibratePrimaryReader(
  network: NetworkConfig,
  contracts: string[],
  fromBlock: number,
  toBlock: number,
  repeats: number
): Promise<Calibration> {
  const answers: number[] = [];
  let errors = 0;
  const reader = readerFor(network);

  for (let i = 1; i <= repeats; i++) {
    const r = await fetchRange(network, contracts, fromBlock, toBlock, async () => { /* count only */ });
    if (!r.complete) {
      errors += 1;
      log.warn(`  ${reader.id} pass ${i}/${repeats}: INCOMPLETE, ${r.skipped.length} skipped chunk(s)`);
    } else {
      answers.push(r.logsSeen);
      log.info(`  ${reader.id} pass ${i}/${repeats}: ${r.logsSeen} log(s)`);
    }
  }

  return summarise(reader.id, network.name, fromBlock, toBlock, answers, errors);
}

async function calibrateRpc(
  network: NetworkConfig,
  contracts: string[],
  fromBlock: number,
  toBlock: number,
  repeats: number
): Promise<Calibration[]> {
  const out: Calibration[] = [];

  for (const url of network.readers.rpcUrls) {
    // One endpoint at a time, because the question is what THIS endpoint does. A probe across
    // several endpoints measures their union and hides the one that drops answers, which is the
    // endpoint the whole rule exists for.
    const single: NetworkConfig = { ...network, readers: { ...network.readers, rpcUrls: [url] } };
    const answers: number[] = [];
    let errors = 0;

    for (let i = 1; i <= repeats; i++) {
      const p = await probeLogsPresent(single, contracts, fromBlock, toBlock);
      if (p.answeredFully.length === 0) {
        errors += 1;
        log.warn(`  ${url} pass ${i}/${repeats}: errored on at least one sub-range`);
      } else {
        answers.push(p.found);
        log.info(`  ${url} pass ${i}/${repeats}: ${p.found} log(s)`);
      }
    }

    out.push(summarise(url, network.name, fromBlock, toBlock, answers, errors));
  }

  return out;
}

/**
 * Repeat one identical query against every source and report what each one does.
 *
 * Zero answers are counted separately from errors, because an error is visible and a zero is
 * not, and conflating them is how a 14-day scan reported zero skipped chunks while holding 12
 * of 26 real logs.
 */
export async function runCalibrate(opts: PipelineOpts): Promise<boolean> {
  const repeats = CONFIG.CALIBRATION_REPEATS;
  const results: Calibration[] = [];

  for (const network of selectedNetworks(opts.chains)) {
    const targets = targetsFor(network, { addresses: opts.addresses });
    if (targets.length === 0) continue;
    // One contract per chain unless the caller names addresses. Calibration measures the SOURCE,
    // not the contract, and repeating it across 146 contracts would spend a lot of requests to
    // measure the same endpoint over and over.
    const chosen = opts.addresses ? targets : targets.slice(0, 1);

    for (const target of chosen) {
      const from = opts.fromBlock ?? target.firstBlock;
      const to = opts.toBlock ?? from + Math.min(network.readers.rpcLogRange, 1_000) - 1;

      log.info(
        `Calibrating ${target.contractName} ${target.address} on ${network.name} over blocks ` +
        `${from}..${to}, ${repeats} repeats per source`
      );
      results.push(await calibratePrimaryReader(network, [target.address], from, to, repeats));
      results.push(...(await calibrateRpc(network, [target.address], from, to, repeats)));
    }
  }

  log.info("Calibration summary");
  for (const r of results) {
    log.info(
      `  ${r.source} ${r.network} ${r.fromBlock}..${r.toBlock}: ` +
      `answers [${r.answers.join(", ")}], ${r.errors} error pass(es), modal ${r.modeAnswer}, ` +
      `p=${r.p.toFixed(2)}`
    );
    log.info(`    ${r.verdict}`);
  }

  const usable = results.filter((r) => r.answers.length > 0 && r.p === 0);
  log.info(
    `${usable.length} of ${results.length} source-range pairs returned a consistent answer on every pass this session`
  );

  return results.every((r) => r.answers.length > 0);
}
