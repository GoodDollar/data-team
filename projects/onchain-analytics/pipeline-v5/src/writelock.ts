/**
 * writelock.ts -- the cross-process write lease. `C1`'s fix.
 *
 * THE DEFECT, WITH ITS RECEIPT. Two captures of XDC 105,201,000..105,201,500 ran at the same
 * time. Each staged its own copy of the same 47 merge keys, each measured the target before its
 * own MERGE, each MERGE matched against a target snapshot taken before the other had inserted,
 * and so both inserted. `RawLogs` ended with 149 stored rows over 102 distinct keys -- 47
 * phantoms -- and BOTH processes exited 0 while every coverage row and every `PipelineRuns` row
 * said complete. Nothing in the write path excluded the second writer, and nothing in the
 * bookkeeping recorded that there had been one.
 *
 * WHY A FILE AND NOT A TABLE. A lease in BigQuery would need `tables.updateData` on a production
 * dataset held for the whole run, which is one of the permissions this project exists to keep
 * revoked, and it would put the lock's own correctness behind the same MERGE semantics that
 * produced the defect. The thing being excluded is a second OS PROCESS on one host invoking one
 * operator-run pipeline, so the exclusion belongs at the host. `open(..., "wx")` is a single
 * atomic create-if-absent syscall on both Windows and POSIX: exactly one caller can win it, with
 * no compare-then-write window for a second caller to land in.
 *
 * WHAT IT DOES NOT CLAIM. This excludes concurrent writers on ONE HOST. Two machines writing the
 * same table at once would need a lease the cloud arbitrates, and nothing in this deployment can
 * produce that: there is one operator-invoked writer. If a second host ever becomes real, this
 * file is the wrong mechanism and the right one is a fenced broker -- stated here rather than
 * discovered when it silently fails to exclude anything.
 *
 * THREE PROPERTIES, each guarding a way a naive file lock goes wrong.
 *
 *   THE HOLDER IS IDENTIFIED BY A TOKEN, NOT BY THE PATH. A lease reclaimed as stale can be
 *   re-acquired by someone else while the original holder is still alive; if release only
 *   unlinked the path, that holder would delete a lease it no longer owns and admit a third
 *   writer. Release reads the file back and unlinks only if the token still matches.
 *
 *   A STALE LEASE IS RECLAIMED, BUT SLOWLY. A process killed mid-MERGE leaves its file behind,
 *   and a lock that never expires turns one crash into a permanently unwritable table. The
 *   expiry is deliberately much longer than any MERGE: reclaiming a lease that is merely slow
 *   would reintroduce exactly the concurrent write this exists to prevent.
 *
 *   REFUSAL IS AN OUTCOME, NOT A HANG. A waiter that blocks for ever turns a duplicate-row bug
 *   into a stuck pipeline. After `waitMs` the acquire returns null, `stageAndMerge` throws, and
 *   the capture records `incomplete` -- which is the half of `C1` the row count never showed.
 *   Both processes exiting 0 is what made the original incident invisible.
 */

import { openSync, closeSync, writeSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { tmpdir, hostname } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { CONFIG } from "./config.js";
import { log } from "./log.js";
import type { WriteLock, WriteLockHandle } from "./adapters.js";
import type { MergeWindow } from "./types.js";

/** What is written into a lease file. Read back on release, and on a staleness decision. */
export interface LeaseRecord {
  token: string;
  pid: number;
  host: string;
  tableId: string;
  acquiredAt: string;
  window: string | null;
}

export interface FileWriteLockOptions {
  /** Where lease files live. Defaults to `CONFIG.WRITE_LOCK_DIR`, then the system temp dir. */
  dir?: string;
  /** How long to wait for a held lease before refusing. */
  waitMs?: number;
  /** How old a lease must be before it is treated as abandoned. */
  staleMs?: number;
  /** Gap between attempts. */
  pollMs?: number;
  /** Injectable for tests, so a staleness test does not have to wait an hour. */
  now?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One lease file per (project, dataset, table).
 *
 * The dataset is in the name because the same table id in a sandbox and in production are
 * different tables, and serialising a test against production writes would be a lock that
 * reports contention which does not exist.
 */
export function leaseFileName(projectId: string, datasetId: string, tableId: string): string {
  const safe = `${projectId}.${datasetId}.${tableId}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return `gd-pipeline-write.${safe}.lock`;
}

function readLease(path: string): LeaseRecord | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LeaseRecord;
  } catch {
    // Either the holder released between our failed create and this read, or the file is
    // half-written. Both mean "no readable lease", and both are handled by retrying.
    return null;
  }
}

/**
 * Whether the process named in a lease is still running, where that is knowable.
 *
 * Signal 0 performs the permission and existence checks and delivers nothing, so it answers
 * "does this pid exist" without disturbing it. ESRCH means no such process; EPERM means it
 * exists and belongs to someone else, which still counts as alive.
 *
 * This is what keeps the age rule from becoming a foot-gun. Without it a killed run leaves a
 * lease that blocks the next run for a full expiry period, and the expiry has to stay long
 * because shortening it would let a merely-slow MERGE be overrun. With it, the common case --
 * same host, dead pid -- is reclaimed at once, and the age rule is left to cover only the case
 * it is actually needed for, a holder this machine cannot ask about.
 */
function holderIsAlive(held: LeaseRecord): boolean {
  if (held.host !== hostname()) return true;
  try {
    process.kill(held.pid, 0);
    return true;
  } catch (e: any) {
    return e?.code !== "ESRCH";
  }
}

/**
 * A cross-process write lease backed by an exclusive file create.
 *
 * Returns a handle on success and null on refusal. Null is the signal `stageAndMerge` turns into
 * `WRITE_LOCK_REFUSED`, which is what makes the losing process exit nonzero instead of
 * duplicating rows and reporting success.
 */
export function fileWriteLock(options: FileWriteLockOptions = {}): WriteLock {
  const dir = options.dir ?? (CONFIG.WRITE_LOCK_DIR || tmpdir());
  const waitMs = options.waitMs ?? CONFIG.WRITE_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? CONFIG.WRITE_LOCK_STALE_MS;
  const pollMs = options.pollMs ?? 250;
  const now = options.now ?? Date.now;

  return {
    async acquire(tableId: string, window: MergeWindow | null): Promise<WriteLockHandle | null> {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, leaseFileName(CONFIG.GCP_PROJECT_ID, CONFIG.DATASET_ID, tableId));
      const token = randomUUID();
      const deadline = now() + waitMs;

      for (;;) {
        const record: LeaseRecord = {
          token,
          pid: process.pid,
          host: hostname(),
          tableId,
          acquiredAt: new Date(now()).toISOString(),
          window: window ? `${window.fromTs}..${window.toTs}` : null,
        };

        try {
          // "wx" is create-exclusive: it fails rather than truncating if the path exists. This
          // one call IS the mutual exclusion; everything else here is bookkeeping around it.
          const fd = openSync(path, "wx");
          try {
            writeSync(fd, JSON.stringify(record));
          } finally {
            closeSync(fd);
          }
          return {
            release: async () => {
              // Unlink only our own lease. If this one was reclaimed as stale while we were
              // still running, the file now belongs to someone else and deleting it would admit
              // a third writer -- the failure the token exists to prevent.
              const held = readLease(path);
              if (held && held.token !== token) {
                log.warn(
                  `Write lease on ${tableId} was reclaimed by pid ${held.pid} while this process ` +
                  `still held it. Not deleting it. Any rows this process merged were written ` +
                  `alongside another writer.`,
                  { tableId, ourPid: process.pid, holderPid: held.pid }
                );
                return;
              }
              try { unlinkSync(path); } catch { /* already gone; nothing is held either way */ }
            },
          };
        } catch (e: any) {
          if (e?.code !== "EEXIST") throw e;

          const held = readLease(path);
          if (held) {
            const age = now() - Date.parse(held.acquiredAt);
            const dead = !holderIsAlive(held);
            if (dead || age > staleMs) {
              log.warn(
                `Reclaiming a write lease on ${tableId} held by pid ${held.pid} on ${held.host}, ` +
                `taken ${Math.round(age / 1000)}s ago. ` +
                (dead ? "That process is no longer running." : "It has passed its expiry."),
                { tableId, holderPid: held.pid, ageMs: age, holderDead: dead }
              );
              try { unlinkSync(path); } catch { /* another waiter reclaimed it first */ }
              continue;
            }
          }

          if (now() >= deadline) {
            log.error(
              `Refused the write lease on ${tableId} after waiting ${Math.round(waitMs / 1000)}s. ` +
              `Held by pid ${held?.pid ?? "unknown"} on ${held?.host ?? "unknown"} since ` +
              `${held?.acquiredAt ?? "unknown"}.`,
              { tableId, holderPid: held?.pid ?? null }
            );
            return null;
          }
          await sleep(pollMs);
        }
      }
    },
  };
}
