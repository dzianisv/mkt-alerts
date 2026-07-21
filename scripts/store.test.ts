#!/usr/bin/env bun
// Deterministic tests for the concurrency-safe alert store (scripts/store.ts).
//
// Covers the correctness properties the store must guarantee when api.ts and
// check.ts mutate it as SEPARATE processes:
//   • legacy/migration reads (singular `channel` vs `channels[]`)
//   • corrupt / malformed JSON FAILS LOUDLY (never silently wiped to [])
//   • atomic write leaves no `.tmp` litter and releases the lock
//   • stale-lock recovery (dead holder pid OR aged-out lock)
//   • a live, fresh lock causes a bounded-retry timeout with a clear error
//   • concurrent child-process mutations never lose an update
//
// MKT_ALERTS_STORE must be set BEFORE importing store.ts — it resolves STORE_PATH
// (and the lock/temp paths derived from it) at module load, so the module is pulled
// in via top-level dynamic import after the env is populated.

import { test, expect, describe, beforeEach, afterAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join, basename } from "path";

const DIR = join(import.meta.dir, "..", ".cache", `test-store-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
mkdirSync(DIR, { recursive: true });

const STORE_PATH = join(DIR, "agent-alerts.json");
const LOCK_PATH = STORE_PATH + ".lock";
const STORE_MODULE = join(import.meta.dir, "store.ts");

process.env.MKT_ALERTS_STORE = STORE_PATH;

const { addJob, removeJob, markFired, loadJobs, saveJobs, resolveChannelSpec } = await import("./store.ts");

afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

// Each test starts from a clean store — the module caches ONE store path, so we
// reset the on-disk state (store + lock + any temp files) rather than the path.
function cleanStore() {
  for (const f of readdirSync(DIR)) {
    if (f.startsWith(basename(STORE_PATH))) rmSync(join(DIR, f), { force: true });
  }
}
beforeEach(cleanStore);
afterEach(() => {
  delete process.env.MKT_LOCK_TIMEOUT_MS;
  delete process.env.MKT_LOCK_STALE_MS;
  delete process.env.MKT_LOCK_RETRY_MS;
});

const baseJob = (over: Record<string, unknown> = {}) => ({
  desk: "crypto",
  symbol: "BTC-USD",
  conditions: [{ condition: "above", value: 1 }],
  reasoning: "test job",
  ...over,
});

function tmpFiles(): string[] {
  return readdirSync(DIR).filter(f => f.startsWith(basename(STORE_PATH) + ".tmp."));
}

describe("loadJobs — read-only contract", () => {
  test("missing file → [] (fresh install, no throw)", () => {
    expect(existsSync(STORE_PATH)).toBe(false);
    expect(loadJobs()).toEqual([]);
  });

  test("empty / whitespace file → [] (benign)", () => {
    writeFileSync(STORE_PATH, "   \n");
    expect(loadJobs()).toEqual([]);
  });

  test("legacy/migration read: singular `channel` and `channels[]` both resolve", () => {
    // A store written by an older build (singular comma-joined `channel`) must read
    // identically to a newer `channels[]` job — resolveChannelSpec unifies them.
    saveJobs([
      { id: "legacy-1", desk: "crypto", symbol: "BTC-USD", conditions: [{ condition: "below", value: 90000 }], reasoning: "legacy", channel: "email:you@x.com,ntfy:topic-a", created: "2026-01-01T00:00:00.000Z" },
      { id: "modern-1", desk: "stocks", symbol: "AAPL", conditions: [{ condition: "above", value: 250 }], reasoning: "modern", channels: ["telegram-bot:@chan", "stdout"], created: "2026-01-02T00:00:00.000Z" },
    ] as any);

    const jobs = loadJobs();
    expect(jobs).toHaveLength(2);
    expect(resolveChannelSpec(jobs[0])).toBe("email:you@x.com,ntfy:topic-a");
    expect(resolveChannelSpec(jobs[1])).toBe("telegram-bot:@chan,stdout");
  });

  test("corrupt JSON → THROWS (never silently [])", () => {
    writeFileSync(STORE_PATH, "{ this is not json ]");
    expect(() => loadJobs()).toThrow(/corrupt/i);
  });

  test("valid JSON but not an array → THROWS", () => {
    writeFileSync(STORE_PATH, JSON.stringify({ not: "an array" }));
    expect(() => loadJobs()).toThrow(/malformed|array/i);
  });
});

describe("mutations preserve data on corrupt store", () => {
  test("addJob on a corrupt store throws and does NOT overwrite it", () => {
    const corrupt = "{ broken json";
    writeFileSync(STORE_PATH, corrupt);
    expect(() => addJob(baseJob())).toThrow(/corrupt/i);
    // The dangerous behavior we replaced would leave a single-entry array here.
    expect(readFileSync(STORE_PATH, "utf8")).toBe(corrupt);
  });
});

describe("atomic write + lock cleanup", () => {
  test("addJob writes atomically, leaves no temp file, releases the lock", () => {
    const job = addJob(baseJob({ symbol: "ETH-USD" }));
    expect(job.id).toBeTruthy();
    expect(loadJobs().map(j => j.id)).toContain(job.id);
    expect(tmpFiles()).toEqual([]);        // no `.tmp.` litter
    expect(existsSync(LOCK_PATH)).toBe(false); // lock released in finally
  });

  test("removeJob + markFired also clean up their locks and temps", () => {
    const job = addJob(baseJob({ cooldownSec: 3600 }));
    markFired(job.id, "2026-07-18T00:00:00.000Z");
    expect(loadJobs().find(j => j.id === job.id)?.lastFired).toBe("2026-07-18T00:00:00.000Z");
    removeJob(job.id);
    expect(loadJobs().find(j => j.id === job.id)).toBeUndefined();
    expect(tmpFiles()).toEqual([]);
    expect(existsSync(LOCK_PATH)).toBe(false);
  });
});

describe("cross-process lock — stale recovery + bounded timeout", () => {
  test("recovers a stale lock left by a DEAD holder pid (fresh timestamp)", () => {
    // A crashed process leaves its lock behind. A dead pid means it can be cleared
    // even if the timestamp is recent.
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: 999_999_999, ts: Date.now() }));
    const job = addJob(baseJob({ symbol: "SOL-USD" }));
    expect(loadJobs().map(j => j.id)).toContain(job.id);
    expect(existsSync(LOCK_PATH)).toBe(false);
  });

  test("recovers a lock aged past the stale threshold", () => {
    process.env.MKT_LOCK_STALE_MS = "50";
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, ts: Date.now() - 10_000 }));
    const job = addJob(baseJob({ symbol: "XRP-USD" }));
    expect(loadJobs().map(j => j.id)).toContain(job.id);
  });

  test("recovers a garbage (unparseable) lock older than mtime threshold", () => {
    process.env.MKT_LOCK_STALE_MS = "1";
    writeFileSync(LOCK_PATH, "not-json-garbage");
    // Give the lock file an mtime clearly older than the 1ms threshold.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    const job = addJob(baseJob({ symbol: "DOGE-USD" }));
    expect(loadJobs().map(j => j.id)).toContain(job.id);
  });

  test("a LIVE, fresh lock causes a bounded-retry timeout with a clear error", () => {
    // Held by us (alive) with a fresh timestamp → not stale → must time out, not
    // spin forever, and must not corrupt or wipe the store.
    process.env.MKT_LOCK_TIMEOUT_MS = "200";
    process.env.MKT_LOCK_STALE_MS = "60000";
    process.env.MKT_LOCK_RETRY_MS = "20";
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, ts: Date.now() }));

    const start = Date.now();
    expect(() => addJob(baseJob())).toThrow(/could not acquire alert store lock/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(5000);
    // Store untouched (the pre-existing live lock is left as-is for its owner).
    expect(existsSync(STORE_PATH)).toBe(false);
    rmSync(LOCK_PATH, { force: true });
  });
});

describe("concurrent mutations — no lost update", () => {
  test("N parallel child processes each addJob → all land, seeds preserved", async () => {
    // Seed the store, then spawn many independent processes that each append a
    // unique job at the same time. Without the file lock this is a classic
    // read-modify-write race: two writers load the same list and the second
    // rename drops the first's job. With the lock, every write survives.
    const seeds = ["seed-a", "seed-b", "seed-c"];
    saveJobs(seeds.map(id => ({ ...baseJob({ symbol: "BTC-USD" }), id, created: "2026-01-01T00:00:00.000Z" })) as any);

    const worker = join(DIR, "worker.ts");
    writeFileSync(
      worker,
      `const { addJob } = await import(${JSON.stringify(STORE_MODULE)});\n` +
        `addJob({ desk: "crypto", symbol: "BTC-USD", conditions: [{ condition: "above", value: 1 }], reasoning: "concurrent" }, { id: process.argv[2] });\n`,
    );

    const N = 15;
    const ids = Array.from({ length: N }, (_, i) => `child-${i}`);
    const procs = ids.map(id =>
      Bun.spawn(["bun", worker, id], {
        env: { ...process.env, MKT_ALERTS_STORE: STORE_PATH },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const codes = await Promise.all(procs.map(p => p.exited));
    expect(codes.every(c => c === 0)).toBe(true);

    const finalIds = loadJobs().map(j => j.id).sort();
    const expected = [...seeds, ...ids].sort();
    expect(finalIds).toEqual(expected);          // nothing lost, nothing duplicated
    expect(finalIds).toHaveLength(seeds.length + N);
  }, 30_000);
});

describe("pine condition validation (addJob)", () => {
  test("accepts a pine condition that carries a non-empty script", () => {
    const j = addJob(baseJob({
      conditions: [{ condition: "pine", value: 0, signalPlot: "signal",
        script: "//@version=5\nindicator(\"x\")\nplot(1,\"signal\")" }],
      channel: "stdout",
    }) as any);
    expect(j.conditions[0].condition).toBe("pine");
    expect(j.conditions[0].script).toContain("plot(1");
    expect(loadJobs().find(x => x.id === j.id)?.conditions[0].signalPlot).toBe("signal");
  });

  test("rejects a pine condition with no script", () => {
    expect(() => addJob(baseJob({
      conditions: [{ condition: "pine", value: 0 }],
      channel: "stdout",
    }) as any)).toThrow(/pine condition requires a non-empty/);
  });

  test("rejects a pine condition with a blank script", () => {
    expect(() => addJob(baseJob({
      conditions: [{ condition: "pine", value: 0, script: "   " }],
      channel: "stdout",
    }) as any)).toThrow(/script/);
  });
});
