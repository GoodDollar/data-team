/**
 * csv.ts -- strict RFC 4180 reading for the two control seeds.
 *
 * WHAT REPLACED WHAT. The previous loader hand-rolled a character scanner and ended it with
 * `.filter(r => r.length === header.length)`. A row with one extra comma therefore VANISHED: no
 * error, no warning, a smaller contract universe, and an ingestion run that silently covers less
 * than it claims. That is the failure this module exists to make impossible.
 *
 * THE CONTRACT. A control seed is not ordinary data. One malformed byte must stop the pipeline
 * starting, so every check below is fatal on the FIRST offending physical row and none of them
 * can drop, skip, trim or repair anything.
 */

import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";

export class SeedParseError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
    readonly line: number | null = null,
  ) {
    super(`SEED_REJECTED ${path}${line === null ? "" : ` line ${line}`}: ${detail}`);
    this.name = "SeedParseError";
  }
}

export interface StrictCsv {
  readonly path: string;
  /** Header names in file order. */
  readonly header: readonly string[];
  /** Data records, each already proven to have exactly header.length fields. */
  readonly records: readonly (readonly string[])[];
  /** 1-based physical line number of each record, for error messages that a human can act on. */
  readonly recordLines: readonly number[];
  readonly recordDelimiter: "CRLF" | "LF";
  readonly bytes: number;
  /** Physical lines in the file, excluding the single trailing terminator. */
  readonly physicalLines: number;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * Read a control seed under RFC 4180 with every relaxation switched off.
 *
 * `acceptedHeaders` is a list of exact header variants rather than one, because a seed may legally
 * grow a declared block of columns (the boundary-evidence block) in a later phase. Matching is
 * still exact against whichever variant is present; there is no partial or prefix match.
 *
 * Rejects, in order: a byte-order mark, mixed or absent line terminators, a non-printable or
 * non-ASCII byte, a missing final terminator, any quoting or field-count violation csv-parse can
 * detect, an empty file, a duplicate or blank header name, and finally any disagreement between
 * the physical line count and the parsed record count.
 */
export function readStrictCsv(path: string, acceptedHeaders: readonly (readonly string[])[]): StrictCsv {
  const buf = readFileSync(path);

  if (buf.length === 0) throw new SeedParseError(path, "file is empty");
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    throw new SeedParseError(path, "starts with a UTF-8 byte-order mark; a control seed must be plain ASCII");
  }

  const text = buf.toString("utf8");

  const crlf = (text.match(/\r\n/g) ?? []).length;
  const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const bareCr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (bareCr > 0) throw new SeedParseError(path, `${bareCr} bare CR byte(s); line terminators must be uniform CRLF or LF`);
  if (crlf > 0 && bareLf > 0) {
    throw new SeedParseError(path, `mixed line terminators: ${crlf} CRLF and ${bareLf} bare LF`);
  }
  if (crlf === 0 && bareLf === 0) throw new SeedParseError(path, "no line terminator found");
  const recordDelimiter: "CRLF" | "LF" = crlf > 0 ? "CRLF" : "LF";
  const terminator = recordDelimiter === "CRLF" ? "\r\n" : "\n";

  if (!text.endsWith(terminator)) {
    throw new SeedParseError(path, "does not end with a line terminator");
  }
  if (text.endsWith(terminator + terminator)) {
    throw new SeedParseError(path, "ends with a blank line");
  }

  // Line-accurate so a maintainer is told which row to open, not just that the file is bad.
  const physicalLineTexts = text.slice(0, -terminator.length).split(terminator);
  for (let i = 0; i < physicalLineTexts.length; i++) {
    if (!PRINTABLE_ASCII.test(physicalLineTexts[i])) {
      const bad = [...physicalLineTexts[i]].filter((c) => !PRINTABLE_ASCII.test(c)).map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
      throw new SeedParseError(path, `non-printable or non-ASCII character(s) ${[...new Set(bad)].join(", ")}`, i + 1);
    }
  }

  let raw: string[][];
  try {
    raw = parse(text, {
      bom: false,
      delimiter: ",",
      quote: '"',
      escape: '"',
      record_delimiter: terminator,
      columns: false,
      relax_column_count: false,
      relax_quotes: false,
      skip_empty_lines: false,
      skip_records_with_empty_values: false,
      skip_records_with_error: false,
      trim: false,
      ltrim: false,
      rtrim: false,
      comment: undefined,
      cast: false,
    }) as string[][];
  } catch (e) {
    const err = e as { message?: string; lines?: number; code?: string };
    throw new SeedParseError(path, `${err.code ?? "CSV_ERROR"}: ${err.message ?? String(e)}`, err.lines ?? null);
  }

  if (raw.length === 0) throw new SeedParseError(path, "contains no header row");

  const header = raw[0];
  const blank = header.findIndex((h) => h.trim() === "");
  if (blank >= 0) throw new SeedParseError(path, `header column ${blank + 1} is blank`, 1);
  const dupes = header.filter((h, i) => header.indexOf(h) !== i);
  if (dupes.length > 0) throw new SeedParseError(path, `duplicate header column(s): ${[...new Set(dupes)].join(", ")}`, 1);

  const matched = acceptedHeaders.find(
    (v) => v.length === header.length && v.every((h, i) => h === header[i]),
  );
  if (!matched) {
    const expected = acceptedHeaders.map((v) => `  expected (${v.length}): ${v.join(",")}`).join("\n");
    throw new SeedParseError(
      path,
      `header mismatch.\n${expected}\n  found    (${header.length}): ${header.join(",")}`,
      1,
    );
  }

  const records = raw.slice(1);
  for (let i = 0; i < records.length; i++) {
    if (records[i].length !== header.length) {
      // csv-parse should have thrown already; this is the belt to that braces, because a silent
      // field-count drift is the exact defect this module replaces.
      throw new SeedParseError(path, `expected ${header.length} fields, found ${records[i].length}`, i + 2);
    }
  }

  // Task 4. A quoted field may legally contain a record delimiter, which would make records fewer
  // than physical lines. A control seed may not use that latitude: one record is one line, so this
  // count is an exact equality and any embedded newline is rejected here rather than absorbed.
  const physicalLines = physicalLineTexts.length;
  if (records.length !== physicalLines - 1) {
    throw new SeedParseError(
      path,
      `physical/parsed row count disagreement: ${physicalLines} physical lines (1 header + ${physicalLines - 1} data) but ${records.length} parsed records. ` +
        `A field containing an embedded line terminator is not permitted in a control seed.`,
    );
  }

  return {
    path,
    header,
    records,
    recordLines: records.map((_, i) => i + 2),
    recordDelimiter,
    bytes: buf.length,
    physicalLines,
  };
}
