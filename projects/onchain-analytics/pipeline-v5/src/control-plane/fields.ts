/**
 * fields.ts -- field-level validators shared by both control seeds.
 *
 * Every one of these throws. None of them coerces, trims, repairs or defaults. A control seed is
 * the thing that decides what the pipeline covers, so "nearly right" has to be indistinguishable
 * from "wrong" at this layer.
 */

import { SeedParseError } from "./csv.js";

export interface FieldContext {
  readonly path: string;
  readonly line: number;
  readonly column: string;
}

function fail(ctx: FieldContext, detail: string): never {
  throw new SeedParseError(ctx.path, `column '${ctx.column}': ${detail}`, ctx.line);
}

const LOWER_ADDRESS = /^0x[0-9a-f]{40}$/;
const LOWER_HEX32 = /^0x[0-9a-f]{64}$/;

/** A 20-byte address, lowercase. Mixed case is rejected rather than normalised: EIP-55 checksum
 *  casing entering a merge key has already produced duplicate rows in this warehouse. */
export function address(ctx: FieldContext, raw: string): string {
  if (!LOWER_ADDRESS.test(raw)) {
    const why = /^0x[0-9a-fA-F]{40}$/.test(raw)
      ? "contains uppercase hex; addresses must be stored lowercase"
      : "is not a lowercase 20-byte 0x-prefixed address";
    fail(ctx, `'${raw}' ${why}`);
  }
  return raw;
}

export function optionalAddress(ctx: FieldContext, raw: string): string | null {
  return raw === "" ? null : address(ctx, raw);
}

export function hex32(ctx: FieldContext, raw: string): string {
  if (!LOWER_HEX32.test(raw)) fail(ctx, `'${raw}' is not a lowercase 32-byte 0x-prefixed hex value`);
  return raw;
}

export function optionalHex32(ctx: FieldContext, raw: string): string | null {
  return raw === "" ? null : hex32(ctx, raw);
}

/** Exactly "true" or "false". Not "TRUE", not "1", not "yes", not empty. */
export function bool(ctx: FieldContext, raw: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  fail(ctx, `'${raw}' is not exactly 'true' or 'false'`);
}

export function nonEmpty(ctx: FieldContext, raw: string): string {
  if (raw === "") fail(ctx, "is empty, but a value is required");
  return raw;
}

export function oneOf<T extends string>(ctx: FieldContext, raw: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(raw)) {
    fail(ctx, `'${raw}' is not one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

export function mustBeEmpty(ctx: FieldContext, raw: string, because: string): void {
  if (raw !== "") fail(ctx, `must be empty because ${because}, found '${raw}'`);
}

/** A cross-row rule violation. Collected rather than thrown so one run reports every one. */
export interface Violation {
  readonly check: string;
  readonly line: number | null;
  readonly subject: string;
  readonly detail: string;
}

export function violation(check: string, line: number | null, subject: string, detail: string): Violation {
  return { check, line, subject, detail };
}
