/**
 * mkt-alerts — OpenClaw agent-wake plugin.
 *
 * Runs the MIT mkt-alerts checker as an in-process OpenClaw service. On a fixed
 * cadence it fetches live prices from PUBLIC, key-free endpoints (Coinbase for
 * crypto, Yahoo Finance for stocks — never mkt.agentlabs.cc / GCP), evaluates
 * the configured alert conditions with the ported threshold/RSI/SMA/MACD logic,
 * and when one fires it WAKES the agent: it seeds a system event onto the
 * agent's session queue and forces a heartbeat turn so the agent acts on the
 * condition immediately.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
// `buildAgentMainSessionKey` is the publicly-supported way to compute the
// `agent:<id>:<mainKey>` session key. A headless service has no inbound route to
// derive a sessionKey from, so — like the production cron service — we resolve it
// ourselves. NOTE: `DEFAULT_AGENT_ID` is NOT re-exported from plugin-sdk/routing
// (only DEFAULT_MAIN_KEY is), so we use its verified literal value "main".
import { buildAgentMainSessionKey } from "openclaw/plugin-sdk/routing";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { rsi, macd, sma } from "./indicators.ts";

const DEFAULT_AGENT_ID = "main"; // value of the SDK's DEFAULT_AGENT_ID (src/routing/session-key.ts:20)
const DEFAULT_INTERVAL_SEC = 60;
const MIN_INTERVAL_SEC = 10;

// ── Data model (ported from mkt-alerts scripts/store.ts) ─────────────────────

export type Cond = {
  condition: string;
  value: number;
  period?: number;
  // Pine-only fields (condition === "pine"). Pine is OUT OF SCOPE for this MVP.
  script?: string;
  signalPlot?: string;
  fireOn?: "cross_up" | "truthy";
};

export type AlertJob = {
  id: string;
  desk: "crypto" | "stocks" | string;
  symbol: string;
  match?: "all" | "any" | "sequence";
  conditions: Cond[];
  reasoning: string;
  channel?: string;
  channels?: string[];
  created?: string;
  expiry?: string;
  cooldownSec?: number;
  lastFired?: string;
  fired?: boolean;
  analysisLink?: string;
};

/** Pre-fetched data for one job, mirroring mkt-alerts' JobData (minus pine). */
export type JobData = { price: number; changePct?: number; closes?: number[] };

export type PluginConfig = {
  /** Poll cadence in seconds (default 60, floored at 10). */
  intervalSec?: number;
  /** Target agent for the wake (default "main"). */
  agentId?: string;
  /** Inline alert definitions. */
  alerts?: AlertJob[];
  /** Optional path to a JSON file holding an AlertJob[] (merged with `alerts`). */
  alertsFile?: string;
  /** Force a data source instead of routing by desk. */
  dataSource?: "auto" | "coinbase" | "yahoo";
};

// Conditions the checker understands. `pine` is accepted for parity with
// mkt-alerts but is deferred (see evalCond) — it never fires in this MVP.
export const VALID_CONDITIONS = [
  "above",
  "below",
  "pct_up",
  "pct_down",
  "rsi_above",
  "rsi_below",
  "sma_cross_above",
  "sma_cross_below",
  "macd_cross",
  "volume_above",
  "stddev_above",
  "pine",
] as const;

/**
 * Narrow, real-shaped slice of the OpenClaw runtime this plugin needs to wake
 * the agent. Kept as a subset of the true `OpenClawPluginApi`/`PluginRuntime`
 * types so the verification harness can build a lightweight mock; `startService`
 * asserts `const wake: WakeRuntime = api` so `tsc` proves this stays a faithful
 * subset of the real SDK surface (signatures verified against
 * openclaw src/infra/system-events.ts and src/plugins/runtime/types-core.ts).
 */
export interface WakeRuntime {
  logger: PluginLogger;
  runtime: {
    system: {
      enqueueSystemEvent: (
        text: string,
        options: { sessionKey: string; contextKey?: string | null; trusted?: boolean },
      ) => boolean;
      runHeartbeatOnce: (opts?: {
        reason?: string;
        agentId?: string;
        sessionKey?: string;
        heartbeat?: { target?: string };
      }) => Promise<unknown>;
    };
  };
}

// ── Pure evaluation (ported verbatim from scripts/check.ts) ──────────────────

/** Evaluate a single condition against provided data. Returns true if it fires. */
export function evalCond(cond: Cond, data: JobData): boolean {
  const { condition, value, period } = cond;
  const { price, changePct, closes } = data;

  switch (condition) {
    case "above":
      return price > value;
    case "below":
      return price < value;
    case "pct_up":
      return (changePct ?? 0) >= value;
    case "pct_down":
      return (changePct ?? 0) <= -Math.abs(value);
    case "volume_above":
      return false; // volume not available in current data path
    case "stddev_above":
      return false; // requires additional computation

    case "rsi_above": {
      if (!closes) return false;
      const r = rsi(closes, period ?? 14);
      return r > value;
    }
    case "rsi_below": {
      if (!closes) return false;
      const r = rsi(closes, period ?? 14);
      return r < value;
    }
    case "sma_cross_above": {
      if (!closes || closes.length < (period ?? 20) + 1) return false;
      const p = period ?? 20;
      const currentSma = sma(closes, p);
      const prevSma = sma(closes.slice(0, -1), p);
      const currentPrice = closes[closes.length - 1];
      const prevPrice = closes[closes.length - 2];
      return prevPrice <= prevSma && currentPrice > currentSma;
    }
    case "sma_cross_below": {
      if (!closes || closes.length < (period ?? 20) + 1) return false;
      const p = period ?? 20;
      const currentSma = sma(closes, p);
      const prevSma = sma(closes.slice(0, -1), p);
      const currentPrice = closes[closes.length - 1];
      const prevPrice = closes[closes.length - 2];
      return prevPrice >= prevSma && currentPrice < currentSma;
    }
    case "macd_cross": {
      if (!closes) return false;
      const m = macd(closes);
      return (m.prevHist < 0 && m.hist > 0) || (m.prevHist > 0 && m.hist < 0);
    }
    case "pine":
      // Pine requires the isolated AGPL `pine-runner` subprocess. Deferred for
      // this MVP to keep the plugin dependency-free and AGPL-clean; treated as
      // never-firing. TODO: pine support via pine-runner subprocess (keep AGPL
      // isolated — spawn it, never import it).
      return false;
    default:
      return false;
  }
}

/** Pure: evaluate a job given pre-fetched data. Returns { fires, detail }. */
export function evaluateJob(job: AlertJob, data: JobData): { fires: boolean; detail: string } {
  const results = job.conditions.map((c) => ({ cond: c, fires: evalCond(c, data) }));

  const mode = job.match ?? "all";
  let fires: boolean;
  if (mode === "any") {
    fires = results.some((r) => r.fires);
  } else {
    // "all" (default). "sequence" is treated identically to "all" — proper
    // ordering needs cross-run state, deferred (matches mkt-alerts upstream).
    fires = results.every((r) => r.fires);
  }

  const detail = results
    .map((r) => {
      const label =
        r.cond.condition === "pine"
          ? `pine:${r.cond.signalPlot ?? "signal"}`
          : `${r.cond.condition}:${r.cond.value}`;
      return `${label}=${r.fires ? "✓" : "✗"}(price=${data.price})`;
    })
    .join(", ");

  return { fires, detail };
}

// ── Live data fetch (PUBLIC, key-free endpoints — no GCP, no mkt.agentlabs.cc) ─

function pickSource(job: AlertJob, override?: PluginConfig["dataSource"]): "coinbase" | "yahoo" {
  if (override === "coinbase" || override === "yahoo") return override;
  return job.desk === "stocks" ? "yahoo" : "coinbase";
}

/** Crypto via Coinbase public API. Pair form e.g. "BTC-USD". */
async function fetchCrypto(symbol: string, fetchImpl: typeof fetch): Promise<JobData> {
  const spotRes = await fetchImpl(`https://api.coinbase.com/v2/prices/${symbol}/spot`);
  if (!spotRes.ok) throw new Error(`coinbase spot ${symbol}: HTTP ${spotRes.status}`);
  const spot = (await spotRes.json()) as { data?: { amount?: string } };
  const price = Number.parseFloat(spot.data?.amount ?? "");
  if (!Number.isFinite(price)) throw new Error(`coinbase spot ${symbol}: no price`);

  // Daily candles (newest-first): [time, low, high, open, close, volume].
  const candlesRes = await fetchImpl(
    `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=86400`,
    { headers: { "User-Agent": "mkt-alerts-openclaw" } },
  );
  if (!candlesRes.ok) throw new Error(`coinbase candles ${symbol}: HTTP ${candlesRes.status}`);
  const rows = (await candlesRes.json()) as number[][];
  const closes = rows
    .map((r) => r[4])
    .filter((c) => Number.isFinite(c))
    .reverse(); // oldest-first, latest last
  const prevClose = closes.length >= 2 ? closes[closes.length - 2] : undefined;
  const changePct =
    prevClose !== undefined && prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : undefined;
  return { price, changePct, closes };
}

/** Stocks via Yahoo Finance public chart API. Symbol e.g. "AAPL". */
async function fetchStock(symbol: string, fetchImpl: typeof fetch): Promise<JobData> {
  const res = await fetchImpl(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`,
    { headers: { "User-Agent": "Mozilla/5.0" } },
  );
  if (!res.ok) throw new Error(`yahoo chart ${symbol}: HTTP ${res.status}`);
  const j = (await res.json()) as {
    chart?: { result?: Array<{ meta?: { regularMarketPrice?: number }; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
  };
  const result = j.chart?.result?.[0];
  if (!result) throw new Error(`yahoo chart ${symbol}: empty result`);
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(
    (c): c is number => typeof c === "number" && Number.isFinite(c),
  );
  const price = result.meta?.regularMarketPrice ?? closes[closes.length - 1];
  if (!Number.isFinite(price)) throw new Error(`yahoo chart ${symbol}: no price`);
  const prevClose = closes.length >= 2 ? closes[closes.length - 2] : undefined;
  const changePct =
    prevClose !== undefined && prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : undefined;
  return { price: price as number, changePct, closes };
}

/** Fetch live data for a job, routing by desk (or by explicit override). */
export async function fetchJobData(
  job: AlertJob,
  override?: PluginConfig["dataSource"],
  fetchImpl: typeof fetch = fetch,
): Promise<JobData> {
  return pickSource(job, override) === "yahoo"
    ? fetchStock(job.symbol, fetchImpl)
    : fetchCrypto(job.symbol, fetchImpl);
}

// ── Alert loading + fire-state persistence (uses ctx.stateDir, not the repo) ──

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Stable id derived from symbol + conditions, so fire-state survives restarts. */
function deriveId(job: AlertJob): string {
  return slug(`${job.symbol}-${job.conditions.map((c) => c.condition).join("-")}-${job.conditions[0]?.value ?? 0}`);
}

/** Load + validate the alert definitions from inline config and/or alertsFile. */
export function loadAlerts(config: PluginConfig, logger?: PluginLogger): AlertJob[] {
  const raw: AlertJob[] = [...(config.alerts ?? [])];
  if (config.alertsFile) {
    if (existsSync(config.alertsFile)) {
      const text = readFileSync(config.alertsFile, "utf8").trim();
      if (text) {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error(`alertsFile ${config.alertsFile}: expected a JSON array`);
        raw.push(...(parsed as AlertJob[]));
      }
    } else {
      logger?.warn?.(`mkt-alerts: alertsFile not found: ${config.alertsFile}`);
    }
  }

  const jobs: AlertJob[] = [];
  for (const j of raw) {
    if (!j.conditions?.length) {
      logger?.warn?.(`mkt-alerts: skipping alert with no conditions (${j.id ?? j.symbol})`);
      continue;
    }
    let ok = true;
    for (const c of j.conditions) {
      if (!(VALID_CONDITIONS as readonly string[]).includes(c.condition)) {
        logger?.warn?.(`mkt-alerts: skipping alert ${j.id ?? j.symbol}: invalid condition "${c.condition}"`);
        ok = false;
        break;
      }
      if (c.condition === "pine") {
        logger?.warn?.(
          `mkt-alerts: pine condition on ${j.symbol} is not supported in this MVP and will never fire (deferred).`,
        );
      }
    }
    if (!ok) continue;
    jobs.push({ ...j, symbol: (j.symbol ?? "").toUpperCase(), id: j.id?.trim() || deriveId(j) });
  }
  return jobs;
}

type FireState = Record<string, { fired?: boolean; lastFired?: string }>;

function fireStatePath(stateDir: string): string {
  return join(stateDir, "fire-state.json");
}

export function loadFireState(stateDir: string): FireState {
  const path = fireStatePath(stateDir);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`fire-state at ${path} is malformed (expected an object)`);
  }
  return parsed as FireState;
}

/** Persist fire-state atomically (temp file + rename, like mkt-alerts saveJobs). */
export function saveFireState(stateDir: string, state: FireState): void {
  mkdirSync(stateDir, { recursive: true });
  const path = fireStatePath(stateDir);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

/** True when the job should be evaluated (not expired, not one-shot-done, not cooling down). */
export function isActive(job: AlertJob, state: FireState, now: Date): boolean {
  const st = state[job.id] ?? {};
  if (job.expiry && new Date(job.expiry) < now) return false;
  if (!job.cooldownSec && st.fired) return false;
  if (job.cooldownSec && st.lastFired) {
    const elapsed = (now.getTime() - new Date(st.lastFired).getTime()) / 1000;
    if (elapsed < job.cooldownSec) return false;
  }
  return true;
}

function markFired(state: FireState, job: AlertJob, isoTs: string): void {
  const st = state[job.id] ?? {};
  if (job.cooldownSec) st.lastFired = isoTs;
  else st.fired = true;
  state[job.id] = st;
}

// ── Wake message + wake action ───────────────────────────────────────────────

/** Human-readable wake text the agent sees on its next turn. */
export function buildAlertText(job: AlertJob, data: JobData, detail: string, isoTs: string): string {
  const joiner = job.match === "any" ? " OR " : " AND ";
  const trigger = job.conditions.map((c) => `${c.condition} @ ${c.value}`).join(joiner);
  return (
    `🔔 mkt alert — ${job.symbol} fired @ ${data.price} (${isoTs})\n` +
    `Conditions: ${trigger}\n` +
    `WHY: ${job.reasoning}` +
    (job.analysisLink ? `\n📊 Analysis: ${job.analysisLink}` : "") +
    `\n[${detail}]`
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Wake the agent for a fired alert. First seed the text onto the session queue,
 * then force a heartbeat turn NOW. `enqueueSystemEvent` alone only queues text
 * for the next natural prompt; it does NOT make the agent take a turn. We use
 * `runHeartbeatOnce({ heartbeat: { target: "last" } })` — the same pattern the
 * production cron service uses (server-cron.ts) to deliver to the last active
 * channel and avoid the default `target: "none"` suppression — rather than
 * `requestHeartbeatNow`, which has no bundled-plugin precedent. Failures are
 * logged, never thrown, so one bad wake can't crash the interval.
 */
async function fireWake(
  wake: WakeRuntime,
  sessionKey: string,
  agentId: string,
  job: AlertJob,
  text: string,
): Promise<void> {
  try {
    wake.runtime.system.enqueueSystemEvent(text, { sessionKey, trusted: true });
    await wake.runtime.system.runHeartbeatOnce({
      agentId,
      sessionKey,
      reason: `mkt-alert:${job.id}`,
      heartbeat: { target: "last" },
    });
  } catch (err) {
    wake.logger.warn(`mkt-alerts: wake failed for ${job.id}: ${errMsg(err)}`);
  }
}

// ── The tick (exported so the verification harness can drive it directly) ─────

export type RunCheckTickOptions = {
  config: PluginConfig;
  stateDir: string;
  logger: PluginLogger;
  wake: WakeRuntime;
  sessionKey: string;
  agentId: string;
  /** Injectable for tests; defaults to the live public-endpoint fetcher. */
  fetchData?: (job: AlertJob) => Promise<JobData>;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
};

/** One evaluation pass: load alerts, fetch data, evaluate, wake + persist on fire. */
export async function runCheckTick(
  opts: RunCheckTickOptions,
): Promise<{ evaluated: number; fired: string[] }> {
  const now = opts.now ?? (() => new Date());
  const fetchData =
    opts.fetchData ?? ((job: AlertJob) => fetchJobData(job, opts.config.dataSource));

  const jobs = loadAlerts(opts.config, opts.logger);
  const state = loadFireState(opts.stateDir);
  const active = jobs.filter((j) => isActive(j, state, now()));

  const fired: string[] = [];
  let stateDirty = false;

  for (const job of active) {
    let data: JobData;
    try {
      data = await fetchData(job);
    } catch (err) {
      opts.logger.warn(`mkt-alerts: fetch failed for ${job.symbol} (${job.id}): ${errMsg(err)}`);
      continue;
    }

    let result: { fires: boolean; detail: string };
    try {
      result = evaluateJob(job, data);
    } catch (err) {
      opts.logger.warn(`mkt-alerts: evaluate failed for ${job.id}: ${errMsg(err)}`);
      continue;
    }

    if (!result.fires) continue;

    const isoTs = now().toISOString();
    const text = buildAlertText(job, data, result.detail, isoTs);
    opts.logger.info(`mkt-alerts: ${job.id} FIRED — ${result.detail}`);
    await fireWake(opts.wake, opts.sessionKey, opts.agentId, job, text);
    markFired(state, job, isoTs);
    stateDirty = true;
    fired.push(job.id);
  }

  if (stateDirty) saveFireState(opts.stateDir, state);
  return { evaluated: active.length, fired };
}

// ── Service wiring ────────────────────────────────────────────────────────────

function startService(api: OpenClawPluginApi, ctx: OpenClawPluginServiceContext) {
  // Compile-time proof that our narrow WakeRuntime is a faithful subset of the
  // real SDK api surface — if the SDK signatures drift, this assignment fails tsc.
  const wake: WakeRuntime = api;

  const config = (api.pluginConfig ?? {}) as PluginConfig;
  const agentId = config.agentId ?? DEFAULT_AGENT_ID;
  const sessionKey = buildAgentMainSessionKey({ agentId });
  const intervalMs =
    Math.max(config.intervalSec ?? DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC) * 1000;

  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = () =>
    runCheckTick({
      config,
      stateDir: ctx.stateDir,
      logger: ctx.logger,
      wake,
      sessionKey,
      agentId,
    }).catch((err) => {
      ctx.logger.warn(`mkt-alerts: tick failed: ${errMsg(err)}`);
      return { evaluated: 0, fired: [] as string[] };
    });

  ctx.logger.info(
    `mkt-alerts: checker started (interval=${intervalMs / 1000}s, agent=${agentId}, sessionKey=${sessionKey})`,
  );

  // Run once immediately, then on the configured cadence.
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.(); // don't keep the process alive just for this poller

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export default definePluginEntry({
  id: "mkt-alerts",
  name: "Market Alerts",
  description: "Watches public market data and wakes the agent when your alert conditions fire.",
  register(api: OpenClawPluginApi) {
    let stopFn: (() => void) | null = null;
    api.registerService({
      id: "mkt-alerts-checker",
      start: (ctx) => {
        stopFn = startService(api, ctx);
      },
      stop: () => {
        stopFn?.();
        stopFn = null;
      },
    });
  },
});
