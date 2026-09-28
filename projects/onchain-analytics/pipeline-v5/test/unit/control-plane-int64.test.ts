/**
 * The INT64 sentinel contract.
 *
 * WHY THIS IS ITS OWN SUITE. BigQuery INT64 reaches 9,223,372,036,854,775,807. JavaScript numbers
 * are exact to 9,007,199,254,740,991. The seeds use the exact INT64 maximum as the "no upper bound
 * yet" sentinel on 142 rows, and `Number("9223372036854775807")` silently returns
 * 9223372036854775808 -- a DIFFERENT integer that regenerates into the seed as a different lexeme.
 * The previous loader did exactly that, on every one of those rows, with no error.
 *
 * Every case below is a lexeme that a careless parser would accept as "close enough".
 */

import { describe, it, expect } from "vitest";
import {
  INT64_MAX_LEXEME, Int64ContractError, parseFiniteInt, parseUpperBound, parseLowerBound,
  compareBounds, boundLexeme, boundToNullableNumber,
} from "../../src/control-plane/int64.js";

const INT64_MAX_MINUS_ONE = "9223372036854775806";
const INT64_MAX_PLUS_ONE = "9223372036854775808";

describe("the sentinel is accepted only as an open-ended upper bound", () => {
  it("normalizes the exact INT64-max lexeme to an open-ended bound, never a number", () => {
    const b = parseUpperBound("valid_to_block", INT64_MAX_LEXEME, { declaredOpenEnded: true });
    expect(b.kind).toBe("open_ended");
    expect(b).not.toHaveProperty("value");
    expect(boundToNullableNumber(b)).toBeNull();
  });

  it("round-trips the sentinel lexeme byte for byte", () => {
    const b = parseUpperBound("valid_to_block", INT64_MAX_LEXEME, { declaredOpenEnded: true });
    expect(boundLexeme(b)).toBe(INT64_MAX_LEXEME);
    // The failure this guards: String(Number(INT64_MAX_LEXEME)) is a different decimal.
    expect(String(Number(INT64_MAX_LEXEME))).not.toBe(INT64_MAX_LEXEME);
  });

  it("rejects the sentinel in a lower bound", () => {
    expect(() => parseLowerBound("valid_from_block", INT64_MAX_LEXEME)).toThrow(Int64ContractError);
    expect(() => parseLowerBound("valid_from_block", INT64_MAX_LEXEME)).toThrow(/open-ended upper bound/);
  });

  it("rejects the sentinel on a row that is not declared open ended", () => {
    expect(() => parseUpperBound("valid_to_block", INT64_MAX_LEXEME, { declaredOpenEnded: false }))
      .toThrow(/not declared current\/open-ended/);
  });

  it("rejects a finite upper bound on a row that IS declared open ended", () => {
    // The other half of the contradiction: if both spellings were tolerated, "is this era still
    // current" would have two answers that could disagree.
    expect(() => parseUpperBound("valid_to_block", "123456", { declaredOpenEnded: true }))
      .toThrow(/declared current\/open-ended but carries a finite upper bound/);
  });

  it("rejects the sentinel in an ordinary integer field", () => {
    expect(() => parseFiniteInt("creation_block", INT64_MAX_LEXEME)).toThrow(Int64ContractError);
  });
});

describe("unsafe and non-canonical integers are refused rather than rounded", () => {
  const rejected: [string, string][] = [
    ["INT64-max minus one", INT64_MAX_MINUS_ONE],
    ["INT64-max plus one", INT64_MAX_PLUS_ONE],
    ["the Number()-rounded neighbour of the sentinel", String(Number(INT64_MAX_LEXEME))],
    ["one above Number.MAX_SAFE_INTEGER", "9007199254740992"],
    ["exponent notation", "9.223372036854776e18"],
    ["exponent notation, capital E", "1E9"],
    ["a decimal point", "105000000.0"],
    ["a leading zero", "0105000000"],
    ["a leading plus", "+105000000"],
    ["a negative", "-1"],
    ["leading whitespace", " 105000000"],
    ["trailing whitespace", "105000000 "],
    ["an internal underscore", "105_000_000"],
    ["hexadecimal", "0x6422c40"],
    ["empty", ""],
    ["not a number at all", "unknown"],
  ];

  for (const [label, lexeme] of rejected) {
    it(`rejects ${label} in a finite field`, () => {
      expect(() => parseFiniteInt("valid_from_block", lexeme)).toThrow(Int64ContractError);
    });
    it(`rejects ${label} in an upper bound`, () => {
      expect(() => parseUpperBound("valid_to_block", lexeme, { declaredOpenEnded: false })).toThrow(Int64ContractError);
    });
  }

  it("accepts the largest integer a JavaScript number represents exactly", () => {
    expect(parseFiniteInt("valid_from_block", "9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("enforces a minimum without converting first", () => {
    expect(() => parseFiniteInt("era_index", "0", { min: 1 })).toThrow(/below the minimum/);
    expect(parseFiniteInt("era_index", "1", { min: 1 })).toBe(1);
  });
});

describe("interval arithmetic never rounds a bound", () => {
  const open = parseUpperBound("valid_to_block", INT64_MAX_LEXEME, { declaredOpenEnded: true });
  const finite = parseUpperBound("valid_to_block", "106000000", { declaredOpenEnded: false });
  const lower = parseLowerBound("valid_from_block", "106000000");

  it("orders open-ended strictly above every finite bound", () => {
    expect(compareBounds(open, finite)).toBeGreaterThan(0);
    expect(compareBounds(finite, open)).toBeLessThan(0);
    expect(compareBounds(open, open)).toBe(0);
  });

  it("compares an adjacent finite-to-open pair as touching, not overlapping and not gapped", () => {
    // Era N ends exactly where era N+1 begins. Half-open intervals, so this is equality.
    expect(compareBounds(finite, lower)).toBe(0);
  });
});
