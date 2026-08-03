/**
 * log.ts -- Structured logger. JSON to file, human-readable to stdout.
 * BigInt-safe. Every line carries run_id. Async file writes.
 */

import { createWriteStream, WriteStream } from "fs";
import { randomUUID } from "crypto";
import { CONFIG } from "./config.js";

export const RUN_ID = randomUUID().slice(0, 8);

type LogLevel = "INFO" | "WARN" | "ERROR";

const logStream: WriteStream = createWriteStream(CONFIG.LOG_FILE, { flags: "a" });
logStream.on("error", (err) => {
  process.stderr.write(`[log.ts] Write stream error: ${err.message}\n`);
});

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

function emit(level: LogLevel, msg: string, meta: Record<string, unknown> = {}): void {
  const ts = new Date().toISOString();
  const entry = { ts, level, run_id: RUN_ID, msg, ...meta };

  // JSON to file
  try {
    logStream.write(JSON.stringify(entry, safeReplacer()) + "\n");
  } catch {
    // Never let logging crash the pipeline
  }

  // Human-readable to stdout
  const metaStr = Object.keys(meta).length > 0
    ? " " + JSON.stringify(meta, safeReplacer())
    : "";
  const prefix = level === "INFO" ? "" : `[${level}] `;
  console.log(`${ts} ${prefix}${msg}${metaStr}`);
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit("INFO", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("WARN", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("ERROR", msg, meta),
};

export function flushLogs(): Promise<void> {
  return new Promise((resolve) => {
    logStream.end(resolve);
  });
}
