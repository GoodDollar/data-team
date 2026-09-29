/**
 * magnitude.ts -- plausibility bands for every numeric field a semantic model consumes.
 *
 * WHY A SEPARATE LINE OF DEFENCE. Grain, referential and uniqueness tests all pass on a silently
 * wrong decode, and this warehouse has paid for that twice: a 1e16 decimal factor and a duplicate
 * ingestion both survived a fully green suite. A structural test asks "is there exactly one row";
 * a magnitude test asks "is this number a possible quantity of the thing it claims to be".
 *
 * THE CASE THIS EXISTS FOR, stated exactly. When two implementations of one event differ only in
 * their `indexed` flags they share a `topic0`, and a decoder given them in the wrong order decodes
 * an era-2 log against the era-1 layout and returns `balance = 4` -- the BYTE LENGTH of the string
 * `"celo"` read as a uint256. Nothing throws. Every structural test passes. The only thing that
 * catches it is noticing that 4 raw units of an 18-decimal token is 0.000000000000000004 GD, which
 * is not a quantity anybody claims. So the lower bound below is expressed in RAW units against the
 * token's declared decimals, not in human units, because that is the form the failure takes.
 *
 * AN HONEST LIMIT, because a control whose reach is overstated is worse than none. A magnitude
 * band catches a large factor error always and a small one only when the value is big enough. A
 * 1e18 error -- the divide missing entirely -- is always caught. A 1e2 error is caught above about
 * 1,000 GD and missed below it. That is a real gap, it is why this is a SECOND line of defence and
 * not the first, and it is written here rather than discovered later.
 */

export interface MagnitudeBand {
  /** The field this band guards, as `Event.param`. */
  readonly field: string;
  readonly solidityType: string;
  /**
   * Smallest raw value that is a real quantity, as a power of ten BELOW the token's decimals.
   * `6` means "at least 1e(decimals-6)", i.e. a millionth of one token. Null for a field that is
   * not a token amount.
   */
  readonly rawFloorDecimalsBelow: number | null;
  /** Inclusive bounds on the human-scaled value. */
  readonly minHuman: number;
  readonly maxHuman: number;
  readonly why: string;
}

/**
 * One band per consumed numeric field.
 *
 * The consumed events are `UBIClaimed`, `InviteeJoined` and `InviterBounty` -- derived in Phase 2B
 * by walking every semantic and mart model down to the raw tables it reads. `InviteeJoined`
 * carries no numeric parameter at all (two addresses), so three fields need a band, not three
 * events' worth.
 */
export const MAGNITUDE_BANDS: readonly MagnitudeBand[] = [
  {
    field: "UBIClaimed.amount",
    solidityType: "uint256",
    rawFloorDecimalsBelow: 6,
    minHuman: 0,
    maxHuman: 100_000,
    why:
      "a single UBI claim is a small quantity of GD. The measured Celo daily amount has ranged from " +
      "roughly 74 to 333 GD per claim. The upper bound matches the shipped dbt test byte for byte so " +
      "the code and the SQL cannot drift apart",
  },
  {
    field: "InviterBounty.bountyPaid",
    solidityType: "uint256",
    rawFloorDecimalsBelow: 6,
    minHuman: 0,
    maxHuman: 100_000,
    why:
      "the inviter's own portion of an invite bounty. Measured at 1000 GD on all 939 rows in the " +
      "warehouse, and the contract's levels array tops out far below this bound, so the band leaves " +
      "room for a level-based bonus without leaving room for a factor error",
  },
  {
    field: "InviterBounty.inviterLevel",
    solidityType: "uint256",
    rawFloorDecimalsBelow: null,
    minHuman: 0,
    maxHuman: 100,
    why:
      "an index into the contract's levels array, not a token amount, so it is NOT decimals-scaled. " +
      "Measured at 0 on every row. An address-shaped or 1e18-shaped value here is a decode error, " +
      "and a band this tight is affordable precisely because the field is an ordinal",
  },
] as const;

export type MagnitudeOutcome = "plausible" | "below_raw_floor" | "below_min" | "above_max" | "not_a_number";

export interface MagnitudeVerdict {
  readonly field: string;
  readonly outcome: MagnitudeOutcome;
  readonly plausible: boolean;
  readonly rawValue: bigint | null;
  readonly humanValue: number | null;
  readonly detail: string;
}

export function bandFor(field: string): MagnitudeBand | undefined {
  return MAGNITUDE_BANDS.find((b) => b.field === field);
}

/**
 * Check one raw on-chain value against its band.
 *
 * `decimals` is the TOKEN's declared decimals, which differ per chain in this system -- GD is 18
 * on Celo and XDC and 2 on Fuse and Ethereum. Passing the wrong one is itself the defect this
 * guards against, so it is a required argument with no default.
 */
export function checkMagnitude(field: string, rawValue: bigint, decimals: number): MagnitudeVerdict {
  const band = bandFor(field);
  if (!band) throw new Error(`checkMagnitude: no band declared for '${field}'. Every consumed numeric field needs one`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`checkMagnitude: implausible token decimals ${decimals} for '${field}'`);
  }

  if (band.rawFloorDecimalsBelow === null) {
    const v = Number(rawValue);
    if (!Number.isFinite(v)) {
      return { field, outcome: "not_a_number", plausible: false, rawValue, humanValue: null, detail: `${rawValue} does not survive conversion to a finite number` };
    }
    if (v < band.minHuman) return { field, outcome: "below_min", plausible: false, rawValue, humanValue: v, detail: `${v} is below the minimum ${band.minHuman}` };
    if (v > band.maxHuman) return { field, outcome: "above_max", plausible: false, rawValue, humanValue: v, detail: `${v} is above the maximum ${band.maxHuman}` };
    return { field, outcome: "plausible", plausible: true, rawValue, humanValue: v, detail: `${v} is inside [${band.minHuman}, ${band.maxHuman}]` };
  }

  // The raw floor, which is what catches a wrong-layout decode. Computed in bigint so an
  // 18-decimal token never passes through a float on the way to the comparison.
  const floorExp = BigInt(Math.max(0, decimals - band.rawFloorDecimalsBelow));
  const rawFloor = 10n ** floorExp;
  if (rawValue > 0n && rawValue < rawFloor) {
    return {
      field,
      outcome: "below_raw_floor",
      plausible: false,
      rawValue,
      humanValue: Number(rawValue) / 10 ** decimals,
      detail:
        `raw ${rawValue} is below the raw floor ${rawFloor} for a ${decimals}-decimal token. A value this ` +
        `small is not a quantity anybody transacts; it is the signature of a wrong-layout decode`,
    };
  }

  const human = Number(rawValue) / 10 ** decimals;
  if (!Number.isFinite(human)) {
    return { field, outcome: "not_a_number", plausible: false, rawValue, humanValue: null, detail: `raw ${rawValue} does not scale to a finite number at ${decimals} decimals` };
  }
  if (human <= band.minHuman) return { field, outcome: "below_min", plausible: false, rawValue, humanValue: human, detail: `${human} is at or below the minimum ${band.minHuman}` };
  if (human > band.maxHuman) {
    return {
      field,
      outcome: "above_max",
      plausible: false,
      rawValue,
      humanValue: human,
      detail: `${human} is above the maximum ${band.maxHuman}; at ${decimals} decimals this is what a missing or wrong scale factor looks like`,
    };
  }
  return { field, outcome: "plausible", plausible: true, rawValue, humanValue: human, detail: `${human} is inside (${band.minHuman}, ${band.maxHuman}] at ${decimals} decimals` };
}

/** Every band, run over one decoded row. Returns only the failures, so an empty result is a pass. */
export function checkRowMagnitudes(
  values: readonly { readonly field: string; readonly rawValue: bigint; readonly decimals: number }[],
): MagnitudeVerdict[] {
  return values.map((v) => checkMagnitude(v.field, v.rawValue, v.decimals)).filter((v) => !v.plausible);
}
