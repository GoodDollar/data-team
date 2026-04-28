/**
 * ============================================================================
 * log.ts — Structured logger
 * ============================================================================
 *
 * JSON to file, plain-text to stdout. Every log call can attach a `meta`
 * object; BigInts and circular references in meta are handled without
 * throwing (which would otherwise mask the real error being logged).
 *
 * Every log line carries the run_id so a whole run's timeline can be
 * reconstructed with a single grep.
 *
 * File writes are async via a write stream (not appendFileSync) so they
 * never block the event loop. Call flushLogs() before process.exit to
 * drain the stream buffer.
 * ============================================================================
 */

import { createWriteStream, WriteStream } from "fs";
import { randomUUID } from "crypto";
import { CONFIG } from "./config";

export enum LogLevel {
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
  FATAL = "FATAL",
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  [LogLevel.INFO]: 10,
  [LogLevel.WARN]: 20,
  [LogLevel.ERROR]: 30,
  [LogLevel.FATAL]: 40,
};

const configuredLevel =
  (CONFIG.LOG_LEVEL as LogLevel) in LEVEL_ORDER
    ? (CONFIG.LOG_LEVEL as LogLevel)
    : LogLevel.INFO;

const MIN_LEVEL = LEVEL_ORDER[configuredLevel];

/** Unique id for this process run. Threads through every log line. */
export const RUN_ID = randomUUID().slice(0, 8);

// Buffered async write stream — never blocks the event loop.
const logStream: WriteStream = createWriteStream(CONFIG.LOG_FILE, { flags: "a" });
logStream.on("error", (err) => {
  // Never recurse into our own logger on stream errors.
  process.stderr.write(`[log.ts] Write stream error: ${err.message}\n`);
});

/**
 * Drain the log write stream. Call before process.exit so buffered lines
 * are not lost on shutdown.
 */
export function flushLogs(): Promise<void> {
  return new Promise((resolve) => {
    // end() flushes remaining data, then closes the stream.
    logStream.end(resolve);
  });
}

/**
 * JSON.stringify replacer that handles BigInts and circular references.
 *
 * BigInts are common in decoded event args (any uint256); a naive
 * JSON.stringify throws on them, which would cause the error log itself
 * to throw and mask the real error. Circular refs appear in some client
 * objects passed as meta.
 */
function safeReplacer() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);
    }
    return value;
  };
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj, safeReplacer());
  } catch (e: any) {
    // Last-resort fallback so log() itself never throws
    return JSON.stringify({
      _serialization_error: e?.message ?? String(e),
      _fallback: String(obj),
    });
  }
}

function emit(
  level: LogLevel,
  msg: string,
  meta: Record<string, unknown> = {}
): void {
  if (LEVEL_ORDER[level] < MIN_LEVEL) return;

  const ts = new Date().toISOString();
  const record = {
    timestamp: ts,
    level,
    run_id: RUN_ID,
    message: msg,
    ...meta,
  };

  const jsonLine = safeStringify(record);
  // Human-readable stdout
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [${level}] [${RUN_ID}] ${msg}`);

  // Async write — never blocks. Errors handled by stream error listener.
  logStream.write(jsonLine + "\n");
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    emit(LogLevel.INFO, msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    emit(LogLevel.WARN, msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) =>
    emit(LogLevel.ERROR, msg, meta),
  fatal: (msg: string, meta?: Record<string, unknown>) =>
    emit(LogLevel.FATAL, msg, meta),
};
