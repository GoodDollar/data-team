/**
 * eraIntervals.ts -- the era validity-interval table, and the three properties it must hold.
 *
 * AN ERA IS A VALIDITY INTERVAL, so it is tested like one. "Which ABI was in force at block N" is
 * an as-of temporal join, which is a solved modelling problem -- not an epistemology problem. The
 * rigour belongs in the interval algebra, and that is what this file asserts.
 *
 * THE THREE PROPERTIES, and what each one costs when it is false:
 *
 *   no overlaps     two answers to "which ABI at block N". The decoder takes whichever the join
 *                   returns, silently, and possibly differently between runs.
 *   no gaps         NO answer. A left join against a missing interval returns null rather than
 *                   raising, so every log in the gap decodes to nothing and is indistinguishable
 *                   from a block range that produced no logs.
 *   one covering    the property a reader actually depends on. Resolve a real block, get exactly
 *                   one row. A half-open interval written closed returns two at every boundary.
 *
 * WHY THESE EXIST TWICE. The shipped versions are dbt tests, which need a warehouse target this
 * unit does not have. These are the same three assertions over the same seed, and they RUN. A
 * criterion claimed from a test that never ran is not a criterion, so both exist and the unit
 * report names which unit runs the SQL.
 *
 * WHAT THEY DO NOT DETECT, said plainly: weak evidence. An interval chain can be perfectly shaped
 * and still rest on a single unchallenged source. That is what the confidence grade is for, and
 * saying so is the difference between a test suite and a reassurance.
 */

import { join } from "path";
import { readStrictCsv } from "./csv.js";
import { SEEDS_DIR } from "./chains.js";
import { INT64_MAX_LEXEME } from "./int64.js";
import { violation, type Violation } from "./fields.js";
import { CONFIDENCE_GRADES, type ConfidenceGrade } from "./eraConfidence.js";

export const ERA_INTERVALS_PATH = join(SEEDS_DIR, "era_intervals.csv");

/** The eight columns plan 5.4 names, plus three that make a failure readable. */
export const ERA_INTERVALS_HEADER = [
  "chain", "chain_id", "proxy_address", "valid_from_block", "valid_to_block",
  "implementation", "abi_id", "confidence_grade", "evidence_receipt_uri",
  "contract_name", "era_index", "is_live",
] as const;

/** The eight the plan requires, named separately so a test can assert the contract itself. */
export const ERA_INTERVAL_REQUIRED_COLUMNS = [
  "chain_id", "proxy_address", "valid_from_block", "valid_to_block",
  "implementation", "abi_id", "confidence_grade", "evidence_receipt_uri",
] as const;

export interface EraInterval {
  readonly line: number;
  readonly chain: string;
  readonly chainId: number;
  readonly proxyAddress: string;
  readonly contractName: string;
  readonly eraIndex: number;
  readonly validFromBlock: bigint;
  readonly validToBlock: bigint;
  readonly implementation: string;
  readonly abiId: string;
  readonly confidenceGrade: ConfidenceGrade;
  readonly evidenceReceiptUri: string;
  readonly isLive: boolean;
}

export const OPEN_ENDED = BigInt(INT64_MAX_LEXEME);

export function parseEraIntervals(path = ERA_INTERVALS_PATH): EraInterval[] {
  const csv = readStrictCsv(path, [ERA_INTERVALS_HEADER]);
  return csv.records.map((r, i) => {
    const grade = r[7];
    if (!(CONFIDENCE_GRADES as readonly string[]).includes(grade)) {
      throw new Error(`${path}:${csv.recordLines[i]} confidence_grade '${grade}' is not one of ${CONFIDENCE_GRADES.join(", ")}`);
    }
    return {
      line: csv.recordLines[i],
      chain: r[0],
      chainId: Number(r[1]),
      proxyAddress: r[2],
      validFromBlock: BigInt(r[3]),
      validToBlock: BigInt(r[4]),
      implementation: r[5],
      abiId: r[6],
      confidenceGrade: grade as ConfidenceGrade,
      evidenceReceiptUri: r[8],
      contractName: r[9],
      eraIndex: Number(r[10]),
      isLive: r[11] === "true",
    };
  });
}

function byContract(intervals: readonly EraInterval[]): Map<string, EraInterval[]> {
  const m = new Map<string, EraInterval[]>();
  for (const i of intervals) {
    const k = `${i.chainId}|${i.proxyAddress}`;
    const list = m.get(k);
    if (list) list.push(i);
    else m.set(k, [i]);
  }
  for (const list of m.values()) list.sort((a, b) => a.eraIndex - b.eraIndex);
  return m;
}

/**
 * No two intervals on one contract overlap.
 *
 * Half-open, `[from, to)`, so two intervals overlap when one starts strictly before the other ends
 * AND ends strictly after the other starts. Touching intervals are correct and are not flagged.
 */
export function assertNoOverlappingIntervals(intervals: readonly EraInterval[]): Violation[] {
  const v: Violation[] = [];
  for (const list of byContract(intervals).values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.validFromBlock < b.validToBlock && a.validToBlock > b.validFromBlock) {
          v.push(violation(
            "era_intervals_do_not_overlap",
            b.line,
            `${a.chain} ${a.proxyAddress} (${a.contractName})`,
            `era ${a.eraIndex} [${a.validFromBlock}, ${a.validToBlock}) overlaps era ${b.eraIndex} [${b.validFromBlock}, ${b.validToBlock})`,
          ));
        }
      }
    }
  }
  return v;
}

/**
 * The interval chain is contiguous from the contract's creation to its head.
 *
 * `creationBlockFor` supplies the left edge, because the era table itself cannot know it: an
 * interval chain that is internally perfect but starts 400,000 blocks after the contract was
 * deployed loses every log in between and looks entirely healthy from the inside.
 */
export function assertNoIntervalGaps(
  intervals: readonly EraInterval[],
  creationBlockFor: (chainId: number, proxyAddress: string) => bigint | null,
): Violation[] {
  const v: Violation[] = [];
  for (const list of byContract(intervals).values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const next = list[i];
      if (next.eraIndex !== prev.eraIndex + 1) {
        v.push(violation("era_intervals_have_no_gaps", next.line, `${next.chain} ${next.proxyAddress} (${next.contractName})`,
          `era index jumps from ${prev.eraIndex} to ${next.eraIndex}; an era is missing from the table entirely`));
        continue;
      }
      if (prev.validToBlock !== next.validFromBlock) {
        v.push(violation("era_intervals_have_no_gaps", next.line, `${next.chain} ${next.proxyAddress} (${next.contractName})`,
          `era ${prev.eraIndex} ends at ${prev.validToBlock} but era ${next.eraIndex} starts at ${next.validFromBlock}; the intervals are not contiguous`));
      }
    }

    const first = list[0];
    const creation = creationBlockFor(first.chainId, first.proxyAddress);
    if (creation !== null && first.validFromBlock !== creation) {
      v.push(violation("era_intervals_have_no_gaps", first.line, `${first.chain} ${first.proxyAddress} (${first.contractName})`,
        `the first era starts at ${first.validFromBlock} but the contract was created at ${creation}; the blocks in between belong to no era`));
    }

    const last = list[list.length - 1];
    if (last.isLive && last.validToBlock !== OPEN_ENDED) {
      v.push(violation("era_intervals_have_no_gaps", last.line, `${last.chain} ${last.proxyAddress} (${last.contractName})`,
        `the contract is live but its last era ends at ${last.validToBlock} rather than carrying the open-ended sentinel; every block after it belongs to no era`));
    }
  }
  return v;
}

export interface CoverageProbe {
  readonly chainId: number;
  readonly proxyAddress: string;
  readonly block: bigint;
  readonly kind: string;
}

/** Every real boundary, taken from the intervals themselves rather than invented. */
export function boundaryProbes(intervals: readonly EraInterval[]): CoverageProbe[] {
  const probes: CoverageProbe[] = [];
  for (const i of intervals) {
    probes.push({ chainId: i.chainId, proxyAddress: i.proxyAddress, block: i.validFromBlock, kind: "era_first_block" });
    if (i.validToBlock !== OPEN_ENDED) {
      probes.push({ chainId: i.chainId, proxyAddress: i.proxyAddress, block: i.validToBlock - 1n, kind: "era_last_block" });
    }
  }
  return probes;
}

/** Exactly one interval covers each probe block. Not one or more -- exactly one. */
export function assertExactlyOneIntervalCovers(
  intervals: readonly EraInterval[],
  probes: readonly CoverageProbe[],
): Violation[] {
  const grouped = byContract(intervals);
  const v: Violation[] = [];
  for (const p of probes) {
    const list = grouped.get(`${p.chainId}|${p.proxyAddress}`) ?? [];
    const covering = list.filter((i) => p.block >= i.validFromBlock && p.block < i.validToBlock);
    if (covering.length !== 1) {
      v.push(violation(
        "exactly_one_era_covers_a_queried_block",
        covering[0]?.line ?? null,
        `chain ${p.chainId} ${p.proxyAddress} block ${p.block} (${p.kind})`,
        `${covering.length} interval(s) cover this block${covering.length > 1 ? `: eras ${covering.map((c) => c.eraIndex).join(", ")}` : ""}`,
      ));
    }
  }
  return v;
}
