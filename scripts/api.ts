#!/usr/bin/env bun
/**
 * api.ts — secure HTTP API layer in front of mkt daemon
 *
 * All endpoints require:  Authorization: Bearer <API_TOKEN>
 *
 * Read-only proxies (transparent):
 *   GET  /quotes[/:sym]          → mkt
 *   GET  /metrics                → mkt
 *   POST /webhook/tradingview    → mkt
 *
 * Merged alert endpoints (mkt config + sidecar meta):
 *   GET  /alerts                 → enriched list
 *   POST /alerts                 → create (writes config.yaml, restarts mkt)
 *   DELETE /alerts/:id           → remove (writes config.yaml, restarts mkt)
 *
 * Other:
 *   GET  /subscribe              → { subscribe_url }
 *   GET  /notifications          → enriched alert-history.ndjson
 *
 * Env:
 *   API_TOKEN    — bearer token (required)
 *   NTFY_TOPIC   — ntfy topic name (required)
 *   MKT_ORIGIN   — mkt daemon base URL (default: http://127.0.0.1:8080)
 *   PORT         — listen port (default: 9000)
 *   MKT_CONFIG   — mkt config.yaml path (default: ~/.config/mkt/config.yaml)
 *   MKT_HISTORY  — alert-history.ndjson path (default: ~/.config/mkt/alert-history.ndjson)
 *   META_PATH    — alerts-meta.json path (default: ~/.config/mkt-watch/alerts-meta.json)
 */

import * as YAML from "yaml";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const API_TOKEN  = process.env.API_TOKEN  ?? "";
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? "";
const MKT_ORIGIN = process.env.MKT_ORIGIN ?? "http://127.0.0.1:8080";
const PORT       = parseInt(process.env.PORT ?? "9000");

const home = process.env.HOME ?? "/root";
const MKT_CONFIG  = process.env.MKT_CONFIG  ?? resolve(home, ".config/mkt/config.yaml");
const MKT_HISTORY = process.env.MKT_HISTORY ?? resolve(home, ".config/mkt/alert-history.ndjson");
const META_PATH   = process.env.META_PATH   ?? resolve(home, ".config/mkt-watch/alerts-meta.json");

if (!API_TOKEN)  { console.error("API_TOKEN not set"); process.exit(1); }
if (!NTFY_TOPIC) { console.error("NTFY_TOPIC not set"); process.exit(1); }

// ── Types ─────────────────────────────────────────────────────────────────────

type AlertSubCondition = {
  condition: string;
  value: number;
  period?: number;
};

type AlertRule = {
  symbol: string;
  condition?: string;
  value?: number;
  period?: number;
  enabled: boolean;
  webhooks?: string[];
  conditions?: AlertSubCondition[];
  match?: string;
};

type MktConfig = {
  watchlist: string[];
  portfolios: unknown[];
  alerts: AlertRule[];
  poll_interval: string;
  sparkline_len?: number;
  theme?: string;
  ntfy_topic?: string;
  ntfy_server?: string;
  webhook_url?: string;
};

type AlertMeta = {
  id: string;
  symbol: string;
  conditions: AlertSubCondition[];
  match?: string;
  reason: string;
  analysisLink?: string;
  desk?: string;
  channels?: string[];
  createdAt: string;
  enabled: boolean;
};

type HistoryEntry = {
  Rule: {
    Symbol: string;
    Condition: string;
    Value: number;
    Enabled: boolean;
    Conditions: AlertSubCondition[] | null;
    Match: string;
  };
  Price: number;
  Message: string;
  Timestamp: string;
};

const VALID_CONDITIONS = [
  "above", "below", "pct_up", "pct_down",
  "rsi_above", "rsi_below",
  "sma_cross_above", "sma_cross_below",
  "macd_cross", "volume_above", "stddev_above",
] as const;

// ── Mutex (simple async lock) ─────────────────────────────────────────────────

let writeLock = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn);
  writeLock = next.then(() => {}, () => {});
  return next;
}

// ── Meta store helpers ────────────────────────────────────────────────────────

function loadMeta(): AlertMeta[] {
  if (!existsSync(META_PATH)) return [];
  try {
    return JSON.parse(readFileSync(META_PATH, "utf8")) as AlertMeta[];
  } catch (e) {
    console.error("[meta] failed to parse:", e);
    return [];
  }
}

function saveMeta(meta: AlertMeta[]): void {
  const dir = dirname(META_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = META_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(meta, null, 2));
  renameSync(tmp, META_PATH);
  console.log(`[meta] saved ${meta.length} entries to ${META_PATH}`);
}

// ── mkt config helpers ────────────────────────────────────────────────────────

function loadMktConfig(): MktConfig {
  const raw = readFileSync(MKT_CONFIG, "utf8");
  return YAML.parse(raw) as MktConfig;
}

function saveMktConfig(cfg: MktConfig): void {
  const tmp = MKT_CONFIG + ".tmp";
  writeFileSync(tmp, YAML.stringify(cfg));
  renameSync(tmp, MKT_CONFIG);
  console.log(`[config] wrote ${MKT_CONFIG}`);
}

// ── Daemon restart ────────────────────────────────────────────────────────────

async function restartMkt(): Promise<void> {
  try {
    const proc = Bun.spawn(["pgrep", "-x", "mkt"], { stdout: "pipe", stderr: "pipe" });
    const out  = await new Response(proc.stdout).text();
    const pid  = parseInt(out.trim());
    if (!isNaN(pid) && pid > 0) {
      process.kill(pid, "SIGTERM");
      console.log(`[mkt] sent SIGTERM to pid ${pid} — systemd will restart`);
    } else {
      console.warn("[mkt] pgrep found no running mkt process — config written, applies on next start");
    }
  } catch (e) {
    console.warn("[mkt] restart failed:", e);
  }
}

// ── Alert rule <-> meta matching ──────────────────────────────────────────────

function conditionsMatch(rule: AlertRule, meta: AlertMeta): boolean {
  if (rule.symbol !== meta.symbol) return false;
  const ruleConditions: AlertSubCondition[] = rule.conditions?.length
    ? rule.conditions
    : rule.condition
      ? [{ condition: rule.condition, value: rule.value ?? 0, ...(rule.period ? { period: rule.period } : {}) }]
      : [];
  if (ruleConditions.length !== meta.conditions.length) return false;
  return ruleConditions.every((rc, i) => {
    const mc = meta.conditions[i];
    return mc && rc.condition === mc.condition && rc.value === mc.value &&
      (rc.period ?? 0) === (mc.period ?? 0);
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function authorized(req: Request): boolean {
  return (req.headers.get("authorization") ?? "") === `Bearer ${API_TOKEN}`;
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Upstream proxy ────────────────────────────────────────────────────────────

async function proxy(req: Request, upstreamUrl: string): Promise<Response> {
  try {
    const upReq = new Request(upstreamUrl, {
      method: req.method,
      headers: (() => {
        const h = new Headers(req.headers);
        h.delete("authorization"); // mkt on loopback has no auth
        return h;
      })(),
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });
    const res = await fetch(upReq);
    return new Response(res.body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream" },
    });
  } catch {
    return json({ error: "upstream unavailable" }, 502);
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleSubscribe(): Response {
  return json({ subscribe_url: `https://ntfy.sh/${NTFY_TOPIC}` });
}

async function handleGetAlerts(): Promise<Response> {
  const meta = loadMeta();

  // Fetch mkt's view; fall back to meta-only on error
  let mktRules: AlertRule[] = [];
  try {
    const res = await fetch(`${MKT_ORIGIN}/alerts`);
    if (res.ok) {
      const body = await res.json() as { rules?: AlertRule[] } | AlertRule[];
      mktRules = Array.isArray(body) ? body : (body.rules ?? []);
    }
  } catch {
    console.warn("[alerts] mkt unreachable — returning meta only");
  }

  // Merge: start with mkt rules, enrich with meta; then append meta-only entries
  const enriched: AlertMeta[] = [];
  const usedMetaIds = new Set<string>();

  for (const rule of mktRules) {
    const m = meta.find(m => conditionsMatch(rule, m));
    if (m) {
      usedMetaIds.add(m.id);
      enriched.push({ ...m, enabled: rule.enabled });
    } else {
      // Rule in mkt but not in meta — expose as anonymous
      const ruleConditions: AlertSubCondition[] = rule.conditions?.length
        ? rule.conditions
        : rule.condition
          ? [{ condition: rule.condition, value: rule.value ?? 0 }]
          : [];
      enriched.push({
        id: crypto.randomUUID(),
        symbol: rule.symbol,
        conditions: ruleConditions,
        match: rule.match,
        reason: "",
        enabled: rule.enabled,
        createdAt: "",
      });
    }
  }

  // Append meta entries not found in mkt rules
  for (const m of meta) {
    if (!usedMetaIds.has(m.id)) enriched.push(m);
  }

  return json(enriched);
}

async function handlePostAlert(req: Request): Promise<Response> {
  let body: Partial<AlertMeta & { reason: string }>;
  try { body = await req.json(); }
  catch { return json({ error: "invalid JSON" }, 400); }

  const { symbol, conditions, match, reason, analysisLink, desk, channels } = body as
    Partial<AlertMeta & { reason: string }>;

  if (!symbol?.trim())          return json({ error: "symbol required" }, 400);
  if (!conditions?.length)      return json({ error: "conditions required (non-empty array)" }, 400);
  if (!reason?.trim())          return json({ error: "reason required" }, 400);

  for (const c of conditions) {
    if (!(VALID_CONDITIONS as readonly string[]).includes(c.condition as typeof VALID_CONDITIONS[number]))
      return json({ error: `invalid condition: ${c.condition}` }, 400);
  }

  const CHANNEL_PREFIXES = ["email:", "telegram:", "telegram-bot:", "ntfy:", "stdout"];
  if (channels) {
    if (!Array.isArray(channels)) return json({ error: "channels must be an array" }, 400);
    for (const ch of channels) {
      if (typeof ch !== "string" || !CHANNEL_PREFIXES.some(p => ch === p || ch.startsWith(p)))
        return json({ error: `invalid channel: ${ch}` }, 400);
    }
  }

  const newMeta: AlertMeta = {
    id: crypto.randomUUID(),
    symbol,
    conditions,
    ...(match             ? { match }        : {}),
    reason,
    ...(analysisLink      ? { analysisLink } : {}),
    ...(desk              ? { desk }         : {}),
    ...(channels?.length  ? { channels }     : {}),
    createdAt: new Date().toISOString(),
    enabled: true,
  };

  const newRule: AlertRule = {
    symbol,
    enabled: true,
    conditions,
    ...(match ? { match } : {}),
  };

  await withLock(async () => {
    const meta = loadMeta();
    meta.push(newMeta);
    saveMeta(meta);
    console.log(`[alerts] created ${newMeta.id} for ${symbol}`);

    const cfg = loadMktConfig();
    cfg.alerts = [...(cfg.alerts ?? []), newRule];
    saveMktConfig(cfg);
  });

  await restartMkt();
  return json(newMeta, 201);
}

async function handleDeleteAlert(id: string): Promise<Response> {
  let removed = false;

  await withLock(async () => {
    const meta = loadMeta();
    const idx  = meta.findIndex(m => m.id === id);
    if (idx === -1) return;

    const target = meta[idx];
    meta.splice(idx, 1);
    saveMeta(meta);
    console.log(`[alerts] removed ${id} (${target.symbol})`);

    const cfg = loadMktConfig();
    cfg.alerts = (cfg.alerts ?? []).filter(r => !conditionsMatch(r, target));
    saveMktConfig(cfg);
    removed = true;
  });

  if (!removed) return json({ error: "not found" }, 404);
  await restartMkt();
  return json({ removed: id });
}

function handleGetNotifications(): Response {
  if (!existsSync(MKT_HISTORY)) return json([]);

  const meta = loadMeta();
  const lines = readFileSync(MKT_HISTORY, "utf8")
    .split("\n")
    .filter(l => l.trim().length > 0)
    .slice(-100);

  const notifications = lines.map(line => {
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      const sym  = entry.Rule?.Symbol ?? "";
      const m    = meta.find(m => m.symbol === sym);
      return {
        symbol:       sym,
        price:        entry.Price,
        message:      entry.Message,
        timestamp:    entry.Timestamp,
        ...(m?.reason       ? { reason: m.reason }             : {}),
        ...(m?.analysisLink ? { analysisLink: m.analysisLink } : {}),
      };
    } catch {
      return null;
    }
  }).filter(Boolean);

  return json(notifications);
}

// ── Server ────────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url  = new URL(req.url);
    const path = url.pathname;

    if (!authorized(req)) return unauthorized();

    // GET /subscribe
    if (req.method === "GET" && path === "/subscribe") {
      return handleSubscribe();
    }

    // GET /alerts
    if (req.method === "GET" && path === "/alerts") {
      return handleGetAlerts();
    }

    // POST /alerts
    if (req.method === "POST" && path === "/alerts") {
      return handlePostAlert(req);
    }

    // DELETE /alerts/:id
    const deleteMatch = path.match(/^\/alerts\/(.+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      return handleDeleteAlert(deleteMatch[1]);
    }

    // GET /notifications
    if (req.method === "GET" && path === "/notifications") {
      return handleGetNotifications();
    }

    // Transparent proxy: /quotes, /metrics, /webhook/tradingview
    if (
      path.startsWith("/quotes") ||
      path.startsWith("/metrics") ||
      path.startsWith("/webhook/")
    ) {
      return proxy(req, `${MKT_ORIGIN}${path}${url.search}`);
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`mkt-api listening on :${PORT}`);
