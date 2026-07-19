#!/usr/bin/env bun
import { join, dirname } from "path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
  statSync,
} from "fs";

// Alert STATE lives in the repo .cache/mkt/ so it travels with the skill and
// is accessible regardless of cwd (daemon/cron can run from anywhere).
// Daemon CONFIG stays in ~/.config/mkt/config.yaml — user config, not skill state.
function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("could not find repo root (.git) from " + start);
    dir = parent;
  }
}

// Store location: an explicit MKT_ALERTS_STORE env override wins (used by the
// deployed systemd timer, which runs outside the git checkout). Otherwise fall
// back to the repo-local .cache/mkt so state travels with the skill in dev.
//
// Resolved at CALL TIME (not cached at module load) so the path always reflects
// the current env. Caching it at load broke tests: Bun evaluates a module once and
// shares it across test files, so the first file to import store.ts would freeze
// STORE_PATH and every other file's MKT_ALERTS_STORE would be ignored. Call-time
// resolution is also harmless in production, where the env is fixed before start.
function storePath(): string {
  const override = process.env.MKT_ALERTS_STORE?.trim();
  return override
    ? override
    : join(findRepoRoot(import.meta.dir), ".cache", "mkt", "agent-alerts.json");
}
function cacheDir(): string {
  return dirname(storePath());
}
function lockPath(): string {
  return storePath() + ".lock";
}

export type Cond = { condition: string; value: number; period?: number };

export type AlertJob = {
  id: string;
  desk: "crypto" | "stocks" | string;
  symbol: string;
  match?: "all" | "any" | "sequence";
  conditions: Cond[];
  reasoning: string;
  // Delivery routes. Legacy jobs carry a single comma-joined `channel` string;
  // API-mirrored jobs carry a `channels[]` array. Read both via resolveChannelSpec
  // so the checker never silently mismatches on shape.
  channel?: string;
  channels?: string[];
  created: string;
  expiry?: string;
  cooldownSec?: number;
  lastFired?: string;
  fired?: boolean;
  analysisLink?: string;
};

/**
 * Canonical delivery spec for a job. Accepts the legacy singular `channel`
 * (possibly comma-joined) and the newer `channels[]` array through one code
 * path, returning the comma-joined form `notify()` in check.ts consumes. A
 * single helper here is the guard against the API and checker drifting apart on
 * channel shape.
 */
export function resolveChannelSpec(job: { channel?: string; channels?: string[] }): string {
  const list = job.channels?.length
    ? job.channels
    : job.channel
      ? job.channel.split(",")
      : [];
  return list.map(s => s.trim()).filter(Boolean).join(",");
}

/**
 * Read the alert store.
 *
 * Contract, chosen so a concurrent read-modify-write can never lose data:
 *   • missing file        → [] (read-only default; a fresh install has no alerts)
 *   • empty / whitespace  → [] (benign — e.g. `touch`ed file, never a partial write
 *                               because saveJobs() only ever renames a complete file)
 *   • corrupt JSON        → THROW (never [])
 *   • valid JSON non-array → THROW
 *
 * Returning [] on corrupt JSON is the dangerous behavior this replaces: addJob()
 * would then persist `[] + newJob`, silently overwriting every existing alert with
 * a single entry. A corrupt store is an operator-visible error, not "no alerts".
 */
export function loadJobs(): AlertJob[] {
  const path = storePath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `alert store at ${path} is corrupt (invalid JSON): ${(e as Error).message}. ` +
        `Refusing to proceed so alerts are not overwritten — inspect or remove the file manually.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `alert store at ${path} is malformed: expected a JSON array, got ${typeof parsed}. ` +
        `Refusing to proceed so alerts are not overwritten.`,
    );
  }
  return parsed as AlertJob[];
}

/**
 * Persist the full job list atomically.
 *
 * Writes to a per-process/per-attempt temp file, then renames it over the store.
 * rename(2) is atomic on POSIX, so a concurrent reader (check.ts) always sees the
 * whole old file or the whole new file — never a half-written one. The temp name
 * is unique per pid + timestamp + random suffix so two writers (api.ts and check.ts
 * on the same box) never clobber each other's temp. A failed write cleans up its
 * own temp rather than leaving `.tmp` litter that could mask the real store.
 */
export function saveJobs(jobs: AlertJob[]): void {
  const path = storePath();
  mkdirSync(cacheDir(), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randChars(6)}`;
  try {
    writeFileSync(tmp, JSON.stringify(jobs, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort cleanup; surface the original error below */
    }
    throw e;
  }
}

// ── Cross-process advisory lock ────────────────────────────────────────────────
//
// api.ts (write API) and check.ts (marks jobs fired) are SEPARATE processes that
// both read-modify-write this one JSON store. An atomic rename alone stops torn
// reads but not lost updates: two processes can both load the same list, each
// append/mutate, and each rename its own copy — the second rename silently drops
// the first's change. Every mutating RMW below therefore runs under a file lock.
//
// The lock is a file created with the exclusive `wx` flag (atomic create-if-absent
// across processes, no dependency). It records the holder's pid + timestamp so a
// crashed holder's lock can be recovered instead of wedging the store forever.

// Lock tuning is read at call time (not cached at module load) so a test — or an
// operator via env — can override timeouts without re-importing the module.
function lockEnvMs(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
// How long to keep retrying before giving up (bounded — never spin forever).
const lockTimeoutMs = () => lockEnvMs("MKT_LOCK_TIMEOUT_MS", 10_000);
// A lock older than this (or whose holder pid is dead) is treated as stale.
const lockStaleMs = () => lockEnvMs("MKT_LOCK_STALE_MS", 30_000);
// Delay between acquisition attempts.
const lockRetryMs = () => lockEnvMs("MKT_LOCK_RETRY_MS", 50);

/** Synchronous sleep with no dependencies — store mutations are synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH → no such process (dead). EPERM → exists but not signalable (alive).
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function lockLooksStale(lock: string, staleMs: number): boolean {
  try {
    const info = JSON.parse(readFileSync(lock, "utf8")) as { pid?: number; ts?: number };
    const ageOk = typeof info.ts === "number" && Date.now() - info.ts > staleMs;
    const pidDead = typeof info.pid === "number" && !isPidAlive(info.pid);
    return ageOk || pidDead;
  } catch {
    // Unreadable/garbage lock content — fall back to file mtime.
    try {
      return Date.now() - statSync(lock).mtimeMs > staleMs;
    } catch {
      return false; // lock disappeared — nothing to clear
    }
  }
}

/**
 * Clear a stale lock ATOMICALLY, so two contenders can't both "steal" it and both
 * enter the critical section. The trick: rename the lock to a per-process unique
 * name. rename(2) on the same source succeeds for exactly ONE caller — the other
 * gets ENOENT because the source is already gone. Only the winner deletes the
 * (now uniquely-named) stale lock and retries. A plain unlink-if-stale would let
 * process B unlink the FRESH lock that process A just recreated after its own
 * steal, handing the lock to two owners at once.
 *
 * Returns true if this process cleared a stale lock (caller should retry the
 * acquire immediately); false if the lock looks live or another contender won.
 */
function tryClearStaleLock(lock: string): boolean {
  if (!lockLooksStale(lock, lockStaleMs())) return false;
  const claim = `${lock}.stale.${process.pid}.${Date.now()}.${randChars(6)}`;
  try {
    renameSync(lock, claim); // atomic claim — only one contender wins this
  } catch {
    return false; // another process already moved/removed it; re-check the loop
  }
  try {
    unlinkSync(claim);
  } catch {
    /* our claimed copy — best effort */
  }
  return true;
}

function acquireLock(): void {
  const lock = lockPath();
  mkdirSync(cacheDir(), { recursive: true });
  const timeoutMs = lockTimeoutMs();
  const retryMs = lockRetryMs();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, "wx"); // atomic create-if-absent
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      // Lock held by someone else — clear it if stale, else back off.
      if (tryClearStaleLock(lock)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `could not acquire alert store lock at ${lock} within ${timeoutMs}ms ` +
            `(held by another process). If no process is running, delete the lock file.`,
        );
      }
      sleepSync(retryMs);
      continue;
    }
    // We exclusively created the lock — from here it is OURS. If stamping the
    // owner info fails, remove the lock we just made so it can't orphan the store
    // until the stale timeout; withLock's finally never runs when acquire throws.
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      closeSync(fd);
      return;
    } catch (e) {
      try { closeSync(fd); } catch { /* may already be closed */ }
      try { unlinkSync(lock); } catch { /* best effort */ }
      throw e;
    }
  }
}

function releaseLock(): void {
  const lock = lockPath();
  // Only remove the lock if we still own it — if our critical section outran the
  // stale threshold another process may have stolen and re-created it; deleting
  // theirs would break their invariant.
  try {
    const info = JSON.parse(readFileSync(lock, "utf8")) as { pid?: number };
    if (info.pid !== process.pid) return;
  } catch {
    /* unreadable — fall through and attempt cleanup */
  }
  try {
    unlinkSync(lock);
  } catch {
    /* already gone — nothing to do */
  }
}

/** Run a read-modify-write under the cross-process lock, always releasing it. */
function withLock<T>(fn: () => T): T {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function randChars(n = 4): string {
  return Math.random().toString(36).slice(2, 2 + n);
}

export const VALID_CONDITIONS = [
  "above", "below", "pct_up", "pct_down",
  "rsi_above", "rsi_below",
  "sma_cross_above", "sma_cross_below",
  "macd_cross",
  "volume_above", "stddev_above",
] as const;

export function addJob(
  partial: Omit<AlertJob, "id" | "created">,
  opts: { id?: string } = {},
): AlertJob {
  if (!partial.reasoning?.trim()) throw new Error("reasoning is required and must be non-empty");
  if (!partial.conditions?.length) throw new Error("at least one condition required");
  for (const c of partial.conditions) {
    if (!(VALID_CONDITIONS as readonly string[]).includes(c.condition)) {
      throw new Error(
        `invalid condition "${c.condition}". Valid: ${VALID_CONDITIONS.join(", ")}`
      );
    }
  }

  const { conditions, symbol } = partial;
  // A caller-supplied id (used when mirroring an API alert so the checker job and
  // the alerts-meta entry share one id and DELETE can remove both) wins; else
  // derive a readable slug id.
  const idBase = slug(`${symbol}-${conditions.map(c => c.condition).join("-")}-${conditions[0].value}`);
  const job: AlertJob = {
    id: opts.id?.trim() || `${idBase}-${randChars(4)}`,
    created: new Date().toISOString(),
    ...partial,
    symbol: symbol.toUpperCase(),
  };

  // The read-modify-write below MUST be atomic across processes: api.ts and
  // check.ts both mutate this store. Without the lock, a concurrent markFired()
  // could load the pre-add list and rename it back, dropping this new job.
  return withLock(() => {
    const jobs = loadJobs();
    // Idempotent on id — replace any existing job with the same id rather than
    // appending a duplicate (protects re-creates / retried API writes).
    const filtered = jobs.filter(j => j.id !== job.id);
    filtered.push(job);
    saveJobs(filtered);
    return job;
  });
}

export function removeJob(id: string): void {
  withLock(() => {
    const jobs = loadJobs().filter(j => j.id !== id);
    saveJobs(jobs);
  });
}

export function markFired(id: string, isoTs: string): void {
  withLock(() => {
    const jobs = loadJobs();
    const job = jobs.find(j => j.id === id);
    if (!job) return;
    if (job.cooldownSec) {
      job.lastFired = isoTs;
    } else {
      job.fired = true;
    }
    saveJobs(jobs);
  });
}

/** True when the job should be evaluated (not expired, not one-shot-done, not in cooldown). */
export function isActive(job: AlertJob, now: Date = new Date()): boolean {
  if (job.expiry && new Date(job.expiry) < now) return false;
  if (!job.cooldownSec && job.fired) return false;
  if (job.cooldownSec && job.lastFired) {
    const elapsed = (now.getTime() - new Date(job.lastFired).getTime()) / 1000;
    if (elapsed < job.cooldownSec) return false;
  }
  return true;
}
