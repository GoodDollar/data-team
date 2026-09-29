/**
 * int64.ts -- the integer contract for every numeric field in the two control seeds.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. BigQuery INT64 spans +/-9,223,372,036,854,775,807. JavaScript
 * numbers are exact only to 9,007,199,254,740,991. The seeds use the exact decimal
 * 9223372036854775807 as the "no upper bound yet" sentinel on 134 registry rows, and
 * `Number("9223372036854775807")` silently yields 9223372036854775808 -- a different integer that
 * round-trips back into the seed as a different lexeme. The previous loader did exactly that.
 *
 * So every integer here is parsed from its ORIGINAL DECIMAL LEXEME, through BigInt, before any
 * Number() conversion is permitted, and the sentinel never becomes a number at all: it becomes a
 * distinct `open_ended` variant that the interval arithmetic understands directly.
 */

/** The exact decimal lexeme that means "open ended". Compared as a string, never as a number. */
export const INT64_MAX_LEXEME = "9223372036854775807";

/** Decimal integer, no sign, no leading zeros (except "0" itself), no exponent, no decimal point. */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * A block bound. `open_ended` is a first-class value, not a large number and not null, so that
 * ordering, overlap and gap checks can compare bounds without ever rounding one.
 */
export type BlockBound =
  | { readonly kind: "finite"; readonly lexeme: string; readonly value: number }
  | { readonly kind: "open_ended"; readonly lexeme: string };

export class Int64ContractError extends Error {
  constructor(readonly field: string, readonly lexeme: string, readonly reason: string) {
    super(`INT64_CONTRACT: field '${field}' value '${lexeme}': ${reason}`);
    this.name = "Int64ContractError";
  }
}

function rejectSentinelShape(field: string, lexeme: string): void {
  if (lexeme === INT64_MAX_LEXEME) {
    throw new Int64ContractError(field, lexeme, "the INT64-max sentinel is permitted only as an open-ended upper bound");
  }
}

/**
 * Parse a finite, non-negative integer that must survive in a JavaScript number exactly.
 *
 * Rejects: the sentinel, exponent notation, decimal points, signs, leading zeros, whitespace, and
 * every integer above Number.MAX_SAFE_INTEGER including the sentinel's immediate neighbours.
 */
export function parseFiniteInt(field: string, raw: string, opts: { min?: number } = {}): number {
  const lexeme = raw;
  if (lexeme === "") throw new Int64ContractError(field, lexeme, "empty, but a value is required");
  if (!CANONICAL_DECIMAL.test(lexeme)) {
    throw new Int64ContractError(field, lexeme, "not a canonical decimal integer (no sign, exponent, point, leading zero or whitespace is allowed)");
  }
  rejectSentinelShape(field, lexeme);

  const big = BigInt(lexeme);
  if (big > MAX_SAFE) {
    throw new Int64ContractError(field, lexeme, `exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}), so it cannot be represented exactly`);
  }
  const value = Number(big);
  const min = opts.min ?? 0;
  if (value < min) throw new Int64ContractError(field, lexeme, `below the minimum permitted value ${min}`);
  return value;
}

/**
 * Parse an upper interval bound.
 *
 * The sentinel is accepted ONLY when the row has independently declared itself open ended, and it
 * never becomes a number. A row that carries the sentinel without that declaration, or declares
 * itself open ended while carrying a finite bound, is a contradiction and is rejected -- those are
 * the two ways an "is this era still current" question could otherwise be answered two ways.
 */
export function parseUpperBound(
  field: string,
  raw: string,
  opts: { declaredOpenEnded: boolean; min?: number },
): BlockBound {
  const lexeme = raw;
  if (lexeme === "") throw new Int64ContractError(field, lexeme, "empty, but an upper bound is required");

  if (lexeme === INT64_MAX_LEXEME) {
    if (!opts.declaredOpenEnded) {
      throw new Int64ContractError(field, lexeme, "carries the open-ended sentinel but the row is not declared current/open-ended");
    }
    return { kind: "open_ended", lexeme };
  }

  if (opts.declaredOpenEnded) {
    throw new Int64ContractError(field, lexeme, `row is declared current/open-ended but carries a finite upper bound; expected the exact lexeme ${INT64_MAX_LEXEME}`);
  }
  return { kind: "finite", lexeme, value: parseFiniteInt(field, lexeme, { min: opts.min }) };
}

/** A lower bound is always finite. The sentinel in a lower bound is rejected by construction. */
export function parseLowerBound(field: string, raw: string, opts: { min?: number } = {}): BlockBound {
  return { kind: "finite", lexeme: raw, value: parseFiniteInt(field, raw, opts) };
}

/** Total order over bounds, with `open_ended` strictly above every finite value. */
export function compareBounds(a: BlockBound, b: BlockBound): number {
  if (a.kind === "open_ended") return b.kind === "open_ended" ? 0 : 1;
  if (b.kind === "open_ended") return -1;
  return a.value - b.value;
}

export function boundsEqual(a: BlockBound, b: BlockBound): boolean {
  return compareBounds(a, b) === 0;
}

/** The original lexeme, so regenerating the seed reproduces the source file byte for byte. */
export function boundLexeme(b: BlockBound): string {
  return b.lexeme;
}

/**
 * Convert a bound for a pipeline API that genuinely needs a number. Open ended becomes null, never
 * Infinity and never a large integer, because a null propagates as "unknown" while a number
 * propagates as a block that exists.
 */
export function boundToNullableNumber(b: BlockBound): number | null {
  return b.kind === "finite" ? b.value : null;
}
