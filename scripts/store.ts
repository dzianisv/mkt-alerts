#!/usr/bin/env bun
import { join, dirname } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

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
const STORE_PATH = process.env.MKT_ALERTS_STORE?.trim()
  ? process.env.MKT_ALERTS_STORE.trim()
  : join(findRepoRoot(import.meta.dir), ".cache", "mkt", "agent-alerts.json");
const CACHE_DIR = dirname(STORE_PATH);

export type Cond = { condition: string; value: number; period?: number };

export type AlertJob = {
  id: string;
  desk: "crypto" | "stocks" | string;
  symbol: string;
  match?: "all" | "any" | "sequence";
  conditions: Cond[];
  reasoning: string;
  channel: string;
  created: string;
  expiry?: string;
  cooldownSec?: number;
  lastFired?: string;
  fired?: boolean;
  analysisLink?: string;
};

export function loadJobs(): AlertJob[] {
  if (!existsSync(STORE_PATH)) return [];
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8")) as AlertJob[];
  } catch {
    return [];
  }
}

export function saveJobs(jobs: AlertJob[]): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(jobs, null, 2), "utf8");
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

export function addJob(partial: Omit<AlertJob, "id" | "created">): AlertJob {
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
  const idBase = slug(`${symbol}-${conditions.map(c => c.condition).join("-")}-${conditions[0].value}`);
  const job: AlertJob = {
    id: `${idBase}-${randChars(4)}`,
    created: new Date().toISOString(),
    ...partial,
    symbol: symbol.toUpperCase(),
  };

  const jobs = loadJobs();
  jobs.push(job);
  saveJobs(jobs);
  return job;
}

export function removeJob(id: string): void {
  const jobs = loadJobs().filter(j => j.id !== id);
  saveJobs(jobs);
}

export function markFired(id: string, isoTs: string): void {
  const jobs = loadJobs();
  const job = jobs.find(j => j.id === id);
  if (!job) return;
  if (job.cooldownSec) {
    job.lastFired = isoTs;
  } else {
    job.fired = true;
  }
  saveJobs(jobs);
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
