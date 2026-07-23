#!/usr/bin/env node
/**
 * mkt-alerts — manage alerts on the remote mkt daemon via HTTP API
 *
 * Config: ~/.config/mkt-watch/auth.json
 *   { "apiUrl": "https://mkt.agentlabs.cc", "token": "<API_TOKEN>" }
 *   (written by deploy.sh — run that first)
 *
 * Usage:
 *   bun mkt-alerts.ts subscribe
 *   bun mkt-alerts.ts add --symbol BTC-USD --condition below --value 90000 --reason "..." [--link <url>] [--cooldown <sec>]
 *   bun mkt-alerts.ts list
 *   bun mkt-alerts.ts remove --id <id>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawn, execFileSync } from "child_process";
import type { ChildProcess } from "child_process";
import { createServer } from "net";

// ── Config ────────────────────────────────────────────────────────────────────

const AUTH_PATH = join(homedir(), ".config", "mkt-watch", "auth.json");

type Auth = { apiUrl: string; token: string };

function loadAuth(): Auth {
  if (!existsSync(AUTH_PATH))
    die(`Config not found: ${AUTH_PATH}\nRun 'bash deploy.sh' first.`);
  return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Auth;
}

// Non-dying variant for the long-lived MCP server: returns null when config is
// absent/unreadable instead of calling die() (which would kill the server).
function tryLoadAuth(): Auth | null {
  if (!existsSync(AUTH_PATH)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Auth;
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

function flagAll(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === `--${name}` && i + 1 < args.length) out.push(args[i + 1]);
  return out;
}

async function api(auth: Auth, method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${auth.apiUrl}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    die(`Can't reach your mkt daemon at ${auth.apiUrl}.\nCheck that it's running and that apiUrl in ${AUTH_PATH} is correct (run 'bash deploy.sh' to set up an instance).`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok) die(`API error ${res.status}: ${data === undefined ? res.statusText : JSON.stringify(data)}`);
  return data;
}

// Like api() but THROWS on failure instead of calling die(). The MCP server is a
// long-lived process — die()/process.exit() would tear it down, so tool handlers
// use apiRaw() and turn thrown errors into JSON-RPC / tool-result errors.
async function apiRaw(auth: Auth, method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${auth.apiUrl}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error(`Can't reach the mkt daemon at ${auth.apiUrl}. Check it's running and that apiUrl in ${AUTH_PATH} is correct (run 'bash deploy.sh').`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok) throw new Error(`API error ${res.status}: ${data === undefined ? res.statusText : JSON.stringify(data)}`);
  return data;
}

// ── `try` — zero-signup local demo of the alert engine ─────────────────────────
// Self-contained, Node-safe (no Bun-only APIs): downloads the mkt engine, runs a
// live price check on 127.0.0.1, and fires a DEMO alert against a real market
// price. Never touches ~/.config/mkt-watch/auth.json — no signup, no API key.

const MKT_VERSION = "0.1.0";
const TRY_SYMBOL = "BTC-USD";

let mktDaemon: ChildProcess | null = null;

function cleanupDaemon(): void {
  const d = mktDaemon;
  mktDaemon = null;
  if (d && d.pid && !d.killed) {
    try { d.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

// Persistent cache so re-runs skip the download. Override with MKT_ALERTS_CACHE.
function tryCacheDir(): string {
  const dir = process.env.MKT_ALERTS_CACHE || join(homedir(), ".cache", "mkt-alerts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Map Node's process.platform/arch to the mkt release asset name.
function mktAsset(): { asset: string; ext: string } {
  const p = process.platform;
  const a = process.arch;
  const map: Record<string, string> = {
    "darwin-arm64": "darwin_arm64",
    "darwin-x64": "darwin_amd64",
    "linux-x64": "linux_amd64",
    "linux-arm64": "linux_arm64",
    "win32-x64": "windows_amd64",
    "win32-arm64": "windows_arm64",
  };
  const asset = map[`${p}-${a}`];
  if (!asset)
    die(
      `'try' does not support this platform (${p}/${a}).\n` +
      `Supported: darwin/arm64, darwin/x64, linux/x64, linux/arm64, win32/x64, win32/arm64.\n` +
      `Install mkt manually from https://github.com/stxkxs/mkt/releases and follow the manual walkthrough in the README.`
    );
  return { asset, ext: p === "win32" ? "zip" : "tar.gz" };
}

// Return path to a cached mkt binary, downloading + extracting it if absent.
async function ensureMkt(): Promise<string> {
  const dir = tryCacheDir();
  const { asset, ext } = mktAsset();
  const binName = process.platform === "win32" ? "mkt.exe" : "mkt";
  const binPath = join(dir, binName);
  if (existsSync(binPath)) {
    console.log(`✓  mkt engine already cached → ${binPath}`);
    return binPath;
  }

  const url = `https://github.com/stxkxs/mkt/releases/download/v${MKT_VERSION}/mkt_${MKT_VERSION}_${asset}.${ext}`;
  process.stdout.write(`⬇️   Downloading mkt engine (${asset}) … `);
  let buf: Buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) die(`download failed: HTTP ${res.status} for ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    die(`download failed for ${url}: ${(e as Error).message}`);
  }
  const archivePath = join(dir, `mkt_${MKT_VERSION}_${asset}.${ext}`);
  writeFileSync(archivePath, buf);
  console.log(`done (${(buf.length / 1048576).toFixed(1)} MB)`);

  process.stdout.write(`📦  Extracting … `);
  try {
    if (ext === "tar.gz") {
      // Extract just the binary; fall back to extract-all if member name differs.
      try {
        execFileSync("tar", ["xzf", archivePath, "-C", dir, binName], { stdio: "ignore" });
      } catch {
        execFileSync("tar", ["xzf", archivePath, "-C", dir], { stdio: "ignore" });
      }
    } else {
      // Windows .zip path — UNTESTED (no Windows machine available). Best-effort via `unzip`.
      try {
        execFileSync("unzip", ["-o", archivePath, binName, "-d", dir], { stdio: "ignore" });
      } catch {
        execFileSync("unzip", ["-o", archivePath, "-d", dir], { stdio: "ignore" });
      }
    }
  } catch (e) {
    die(`extraction failed: ${(e as Error).message}`);
  }
  try { unlinkSync(archivePath); } catch { /* keep going */ }
  if (!existsSync(binPath)) die(`extraction did not produce ${binName} in ${dir}`);
  if (process.platform !== "win32") chmodSync(binPath, 0o755);
  console.log(`done → ${binPath}`);
  return binPath;
}

// Grab a free ephemeral loopback port (small TOCTOU race is fine for a local demo).
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not acquire a free port"))));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Poll the daemon's /quotes endpoint until it serves a real positive price.
async function pollQuote(port: number, symbol: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!mktDaemon) throw new Error("mkt engine exited before serving a quote");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/quotes/${symbol}`);
      if (res.ok) {
        const data = (await res.json()) as { price?: number };
        if (typeof data.price === "number" && data.price > 0) return data.price;
      }
    } catch {
      // engine not listening yet
    }
    process.stdout.write(".");
    await sleep(500);
  }
  throw new Error("timed out waiting for a live quote (20s)");
}

async function runTry(): Promise<void> {
  console.log(`\n🚀  mkt-alerts try — zero-signup local demo\n`);
  console.log(`    Downloads the mkt engine, runs a live price check on 127.0.0.1, and fires`);
  console.log(`    a DEMO alert against a real market price. No signup, no API key, no auth.json.`);
  console.log(`    One-shot local demo of the core evaluation loop — not a persistent daemon.\n`);

  const binPath = await ensureMkt();

  // Seed the watchlist (idempotent; creates ~/.config/mkt/config.yaml if absent).
  process.stdout.write(`🌱  Seeding watchlist (${TRY_SYMBOL}) … `);
  try {
    execFileSync(binPath, ["config", "add", TRY_SYMBOL], { stdio: "ignore", env: process.env });
    console.log("done");
  } catch (e) {
    die(`'mkt config add ${TRY_SYMBOL}' failed: ${(e as Error).message}`);
  }

  const port = await freePort();
  let daemonOutput = "";
  process.stdout.write(`⚙️   Starting local mkt engine on 127.0.0.1:${port} `);
  mktDaemon = spawn(binPath, ["daemon", "--listen", `127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  mktDaemon.stdout?.on("data", (d) => (daemonOutput += d.toString()));
  mktDaemon.stderr?.on("data", (d) => (daemonOutput += d.toString()));
  mktDaemon.on("exit", () => { mktDaemon = null; });

  let price: number;
  try {
    price = await pollQuote(port, TRY_SYMBOL, 20_000);
  } catch (e) {
    console.log("");
    cleanupDaemon();
    die(
      `${(e as Error).message}.\n` +
      (daemonOutput.trim() ? `mkt engine output:\n${daemonOutput.trim()}` : "The mkt engine produced no output.")
    );
  }
  console.log(" live!");

  // Evaluate a demo "above" condition guaranteed to fire on this very check.
  // Mirrors the product's evalCond: case "above": return price > value.
  const threshold = Math.floor(price * 0.999 * 100) / 100;
  const fired = price > threshold;
  const p2 = price.toFixed(2);
  const t2 = threshold.toFixed(2);

  console.log("");
  if (fired) {
    console.log(`🔔 ALERT FIRED — ${TRY_SYMBOL} is $${p2}, above your $${t2} threshold`);
    console.log(`   (live price from your local mkt engine, evaluated on 127.0.0.1, zero signup, zero API key)`);
  } else {
    console.log(`Quote is $${p2}; demo threshold $${t2} did not trigger.`);
  }

  cleanupDaemon();

  console.log(`\n─────────────────────────────────────────────────────────────`);
  console.log(`What just happened: a real live ${TRY_SYMBOL} price was fetched by a local mkt`);
  console.log(`engine and evaluated with the same "above" rule the product uses. The engine`);
  console.log(`has now been stopped — nothing keeps running, and no alert was persisted.\n`);
  console.log(`Next steps:`);
  console.log(`  • Install as a Claude Code skill (agents set alerts right after analysis):`);
  console.log(`      npx skills add github.com/dzianisv/mkt-alerts/ -s mkt-alerts -y`);
  console.log(`    — see the README section "Install as a Claude Code skill".`);
  console.log(`  • Deploy your own always-on instance (optional) for 24/7 push alerts —`);
  console.log(`    see the README section "Deploy your own always-on instance".`);
  console.log(`  • With your own instance + ~/.config/mkt-watch/auth.json, set a permanent alert:`);
  console.log(`      mkt-alerts add --symbol ${TRY_SYMBOL} --condition below --value 90000 \\`);
  console.log(`        --reason "reclaim entry" --data-source "210w OHLCV from TradingView" \\`);
  console.log(`        --channel ntfy:my-topic`);
  console.log(``);
}

// ── MCP server (stdio, newline-delimited JSON-RPC 2.0) ─────────────────────────
// Exposes alerts to AI agents (Claude Desktop/Code, any MCP host) as tool calls.
// Node-safe: reads process.stdin / writes process.stdout, no Bun-only APIs.
// Lazy auth: initialize + tools/list work with no auth.json; loadAuth only on a
// tool call. Errors NEVER call die() — they become JSON-RPC / tool-result errors.

const MCP_PROTOCOL_VERSION = "2024-11-05";

// Threshold conditions accepted by add_alert (pine is handled via pine_script).
const MCP_CONDITIONS = [
  "above", "below", "pct_up", "pct_down",
  "rsi_above", "rsi_below", "sma_cross_above", "sma_cross_below",
  "macd_cross", "volume_above", "stddev_above",
];

const MCP_CHANNEL_PREFIXES = ["email:", "telegram:", "telegram-bot:", "ntfy:", "stdout"];

const MCP_TOOLS = [
  {
    name: "list_alerts",
    description: "List all active market alerts on the configured mkt daemon.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_alert",
    description:
      "Create a market alert (price/RSI/MACD/SMA or inline Pine Script v5). " +
      "Price conditions (above/below) require data_source evidence.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: 'Ticker, e.g. "BTC-USD", "AAPL". Upper-cased before send.' },
        reason: { type: "string", description: "Why this alert exists." },
        conditions: {
          type: "array",
          description: "Threshold conditions; mutually exclusive with pine_script.",
          items: {
            type: "object",
            properties: {
              condition: { type: "string", enum: MCP_CONDITIONS },
              value: { type: "number" },
            },
            required: ["condition", "value"],
            additionalProperties: false,
          },
        },
        pine_script: { type: "string", description: "Inline Pine Script v5 source; mutually exclusive with conditions." },
        signal: { type: "string", description: 'Pine plot that carries the signal (default "signal"). Only with pine_script.' },
        fire_on: { type: "string", enum: ["cross_up", "truthy"], description: "When a pine alert fires (default cross_up). Only with pine_script." },
        data_source: { type: "string", description: "Evidence for the level. REQUIRED when any condition is above/below." },
        desk: { type: "string", description: 'Desk (default "crypto").' },
        link: { type: "string", description: "Optional analysis URL shown in the notification." },
        cooldown: { type: "number", description: "Re-alert after N seconds (default: one-shot)." },
        channels: { type: "array", items: { type: "string" }, description: "Delivery channels: email:, telegram:, telegram-bot:, ntfy:, stdout." },
      },
      required: ["symbol", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_alert",
    description: "Remove an alert by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Alert id" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

// Version reported in serverInfo — read from package.json, fallback "1.1.0".
// "./package.json" resolves next to the source; "../package.json" next to the
// bundled dist/mkt-alerts.js. readFileSync accepts a file: URL under Node & Bun.
function mcpServerVersion(): string {
  for (const rel of ["./package.json", "../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch { /* try next candidate */ }
  }
  return "1.1.0";
}

// Run a tool. Loads auth lazily and throws on any failure (caller maps to error).
async function mcpCallTool(name: string, rawArgs: unknown): Promise<string> {
  const auth = tryLoadAuth();
  if (!auth)
    throw new Error(`Config not found: ${AUTH_PATH}. Run 'bash deploy.sh' first to set your mkt daemon URL + token.`);
  const a = (rawArgs ?? {}) as Record<string, unknown>;

  if (name === "list_alerts") {
    const result = await apiRaw(auth, "GET", "/alerts");
    return JSON.stringify(result, null, 2);
  }

  if (name === "remove_alert") {
    const id = typeof a.id === "string" ? a.id.trim() : "";
    if (!id) throw new Error("id required");
    await apiRaw(auth, "DELETE", `/alerts/${encodeURIComponent(id)}`);
    return `removed ${id}`;
  }

  if (name === "add_alert") {
    const symbol = typeof a.symbol === "string" ? a.symbol.trim() : "";
    if (!symbol) throw new Error("symbol required");
    const reason = typeof a.reason === "string" ? a.reason.trim() : "";
    if (!reason) throw new Error("reason required");

    const pineScript = typeof a.pine_script === "string" && a.pine_script.trim() ? a.pine_script : "";
    const rawConditions = Array.isArray(a.conditions) ? a.conditions : [];

    let builtConditions: Array<Record<string, unknown>>;
    let priceConditions: string[] = [];

    if (pineScript) {
      if (rawConditions.length) throw new Error("provide either conditions or pine_script, not both");
      const fireOn = typeof a.fire_on === "string" ? a.fire_on : "cross_up";
      if (fireOn !== "cross_up" && fireOn !== "truthy") throw new Error('fire_on must be "cross_up" or "truthy"');
      const signalPlot = typeof a.signal === "string" && a.signal ? a.signal : "signal";
      builtConditions = [{ condition: "pine", value: 0, script: pineScript, signalPlot, fireOn }];
    } else {
      if (!rawConditions.length) throw new Error("conditions (non-empty) or pine_script is required");
      builtConditions = rawConditions.map((c, i) => {
        const co = (c ?? {}) as Record<string, unknown>;
        const condition = typeof co.condition === "string" ? co.condition : "";
        if (!MCP_CONDITIONS.includes(condition))
          throw new Error(`invalid condition "${condition}" at index ${i}. Valid: ${MCP_CONDITIONS.join(", ")}`);
        const value = typeof co.value === "number" ? co.value : NaN;
        if (!Number.isFinite(value)) throw new Error(`condition "${condition}" at index ${i} needs a numeric value`);
        return { condition, value };
      });
      priceConditions = builtConditions
        .map((c) => c.condition as string)
        .filter((c) => c === "above" || c === "below");
    }

    // Validate delivery channels — mirror the CLI's prefix + email checks.
    const channels = Array.isArray(a.channels) ? a.channels.map((x) => String(x)) : [];
    for (const ch of channels) {
      if (!MCP_CHANNEL_PREFIXES.some((p) => ch === p || ch.startsWith(p)))
        throw new Error(`invalid channel "${ch}". Use one of: ${MCP_CHANNEL_PREFIXES.join(", ")}<target>`);
      if (ch.startsWith("email:") && !/^email:[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ch))
        throw new Error(`invalid email recipient in "${ch}". Use email:you@example.com`);
    }

    // Hard gate (mirrors the `add` CLI command): price-level conditions
    // (above/below) require data_source. No data source = no alert.
    const dataSource = typeof a.data_source === "string" ? a.data_source.trim() : "";
    if (priceConditions.length > 0 && !dataSource) {
      throw new Error(
        `data_source required for price conditions (above/below). ` +
        `Pull OHLCV data first, then cite the evidence for the level. ` +
        `No data source = no alert. Do not fabricate support levels.`
      );
    }

    const finalReasoning = priceConditions.length > 0 ? `${reason} [data: ${dataSource}]` : reason;

    const desk = typeof a.desk === "string" && a.desk ? a.desk : "crypto";
    const link = typeof a.link === "string" && a.link ? a.link : undefined;
    const cooldown = typeof a.cooldown === "number" && Number.isFinite(a.cooldown) ? a.cooldown : undefined;

    const body: Record<string, unknown> = {
      symbol: symbol.toUpperCase(),
      reasoning: finalReasoning,
      desk,
      conditions: builtConditions,
      ...(link ? { analysisLink: link } : {}),
      ...(cooldown !== undefined ? { cooldownSec: cooldown } : {}),
      ...(channels.length ? { channels } : {}),
    };

    const job = await apiRaw(auth, "POST", "/alerts", body);
    return JSON.stringify(job, null, 2);
  }

  throw new Error(`unknown tool: ${name}`);
}

function mcpWrite(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Handle one parsed JSON-RPC message. Notifications (no id) never get a response.
async function handleMcpMessage(msg: any): Promise<void> {
  const hasId = msg && msg.id !== undefined && msg.id !== null;
  const method = msg?.method;

  // Notifications (incl. notifications/initialized): ignore, send nothing.
  if (!hasId) return;

  const id = msg.id;
  try {
    if (method === "initialize") {
      const pv = msg.params?.protocolVersion;
      mcpWrite({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof pv === "string" ? pv : MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "mkt-alerts", version: mcpServerVersion() },
        },
      });
      return;
    }
    if (method === "ping") {
      mcpWrite({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      mcpWrite({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
      return;
    }
    if (method === "tools/call") {
      const toolName = msg.params?.name;
      const toolArgs = msg.params?.arguments;
      try {
        const text = await mcpCallTool(toolName, toolArgs);
        mcpWrite({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      } catch (e) {
        mcpWrite({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: (e as Error).message }], isError: true },
        });
      }
      return;
    }
    mcpWrite({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    mcpWrite({ jsonrpc: "2.0", id, error: { code: -32603, message: `Internal error: ${(e as Error).message}` } });
  }
}

// Wire stdin → handler → stdout. Stays alive until stdin closes, then exits 0.
async function runMcpServer(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  let chain: Promise<void> = Promise.resolve();

  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        mcpWrite({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      // Serialize handling so responses are emitted in request order.
      chain = chain.then(() => handleMcpMessage(msg)).catch(() => { /* never crash the loop */ });
    }
  });

  await new Promise<void>((resolve) => {
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
  });
  await chain;
}

// ── Commands ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const sub = args[0];

if (!sub || sub === "--help" || sub === "-h") {
  console.log(`mkt-alerts — manage alerts on the remote mkt daemon

commands:
  try                           zero-signup local demo: download mkt, live price, fire a demo alert
  subscribe                     print ntfy subscribe URL
  add     --symbol <SYM>        add an alert
          --condition <cond>    condition (below, above, rsi_below, …); repeat for compound
          --value <num>         threshold; one per --condition
          --reason <text>       why you set this alert
          [--pine <file.pine>]  Pine Script alert (runs off-TradingView); replaces --condition/--value
          [--signal <plot>]     Pine plot that carries the signal (default: "signal")
          [--fire-on <mode>]    cross_up (default) | truthy — when a pine alert fires
          [--link <url>]        optional analysis URL in the notification
          [--cooldown <sec>]    re-alert after N seconds (default: one-shot)
          [--desk crypto|stocks]
          [--channel <spec>]    delivery channel; repeat for several. one of:
                                  email:you@example.com
                                  telegram-bot:@CryptoAiInvestor
                                  ntfy:my-topic   (default: your ntfy topic)
  list                          list active alerts
  remove  --id <id>             remove alert by ID
  mcp                           run as an MCP server (stdio) for AI agents (Claude Desktop/Code)

valid conditions:
  above, below, pct_up, pct_down,
  rsi_above, rsi_below, sma_cross_above, sma_cross_below,
  macd_cross, volume_above, stddev_above, pine

config: ${AUTH_PATH}`);
  process.exit(0);
}

// `try` runs BEFORE loadAuth() — it must never touch ~/.config/mkt-watch/auth.json.
if (sub === "try") {
  process.on("exit", cleanupDaemon);
  process.on("SIGINT", () => { cleanupDaemon(); process.exit(130); });
  process.on("SIGTERM", () => { cleanupDaemon(); process.exit(143); });
  await runTry();
  process.exit(0);
}

// The MCP server runs BEFORE loadAuth() — it must start and answer
// initialize/tools/list without ~/.config/mkt-watch/auth.json. Auth is loaded
// lazily inside tool handlers (tryLoadAuth), never at startup.
if (sub === "mcp") {
  await runMcpServer();
  process.exit(0);
}

const auth = loadAuth();

if (sub === "subscribe") {
  const data = await api(auth, "GET", "/subscribe") as { subscribe_url: string };
  console.log(`\n📲  Subscribe to alerts in the ntfy app:\n`);
  console.log(`    ${data.subscribe_url}`);
  console.log(`\n    iOS / Android: https://ntfy.sh/#download`);
  console.log(`    Browser:        ${data.subscribe_url}\n`);

} else if (sub === "list") {
  const jobs = await api(auth, "GET", "/alerts") as any[];
  if (!jobs.length) { console.log("no alerts"); process.exit(0); }
  console.log("ID".padEnd(36) + " SYMBOL".padEnd(10) + " CONDITIONS".padEnd(30) + " STATUS   REASON");
  console.log("─".repeat(110));
  const now = new Date();
  for (const j of jobs) {
    const conds = j.conditions.map((c: any) => `${c.condition}@${c.value}`).join(",");
    const expired = j.expiry && new Date(j.expiry) < now;
    const status = j.fired ? "fired" : expired ? "expired" : "active";
    const reason = (j.reasoning ?? "").slice(0, 40);
    console.log(`${j.id.padEnd(36)} ${j.symbol.padEnd(9)} ${conds.padEnd(29)} ${status.padEnd(9)} ${reason}`);
    if (j.analysisLink) console.log(" ".repeat(37) + "📊 " + j.analysisLink);
  }

} else if (sub === "remove") {
  const id = flag(args, "id") ?? die("--id required");
  await api(auth, "DELETE", `/alerts/${id}`);
  console.log(`removed ${id}`);

} else if (sub === "add") {
  const symbol     = flag(args, "symbol")    ?? die("--symbol required");
  const reasoning  = flag(args, "reason")    ?? die("--reason required");
  const pineFile   = flag(args, "pine");
  const conditions = flagAll(args, "condition");
  const values     = flagAll(args, "value");
  const desk       = flag(args, "desk")      ?? "crypto";
  const link       = flag(args, "link");
  const cooldown   = flag(args, "cooldown");
  const channels   = flagAll(args, "channel");

  // Pine Script alert path: --pine <file.pine> [--signal <plot>] [--fire-on cross_up|truthy].
  // The script is evaluated off-TradingView by the checker's isolated pine-runner
  // subprocess; it replaces the --condition/--value threshold form.
  let builtConditions: Array<Record<string, unknown>>;
  if (pineFile) {
    if (!existsSync(pineFile)) die(`--pine file not found: ${pineFile}`);
    const script = readFileSync(pineFile, "utf8");
    if (!script.trim()) die(`--pine file is empty: ${pineFile}`);
    const fireOn = flag(args, "fire-on") ?? "cross_up";
    if (fireOn !== "cross_up" && fireOn !== "truthy") die(`--fire-on must be "cross_up" or "truthy"`);
    builtConditions = [{ condition: "pine", value: 0, script, signalPlot: flag(args, "signal") ?? "signal", fireOn }];
  } else {
    if (!conditions.length) die("--condition required (or use --pine <file>)");
    if (conditions.length !== values.length) die("each --condition needs a --value");
    builtConditions = conditions.map((c, i) => ({ condition: c, value: parseFloat(values[i]) }));
  }

  // Validate delivery channels. Recipient is carried after the prefix, e.g.
  //   --channel email:you@example.com
  //   --channel telegram-bot:@CryptoAiInvestor
  // Repeat --channel to deliver to several places (email + telegram together).
  const CHANNEL_PREFIXES = ["email:", "telegram:", "telegram-bot:", "ntfy:", "stdout"];
  for (const ch of channels) {
    if (!CHANNEL_PREFIXES.some(p => ch === p || ch.startsWith(p)))
      die(`invalid --channel "${ch}". Use one of: ${CHANNEL_PREFIXES.join(", ")}<target>`);
    if (ch.startsWith("email:") && !/^email:[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ch))
      die(`invalid email recipient in "${ch}". Use --channel email:you@example.com`);
  }

  // Hard gate: price-level conditions require --data-source.
  // Prevents fabricated support/resistance levels from being stored.
  // Indicator conditions (rsi_above, rsi_below, macd_cross, etc.) are exempt.
  const priceConditions = pineFile ? [] : conditions.filter(c => c === "above" || c === "below");
  if (priceConditions.length > 0) {
    const dataSource = flag(args, "data-source");
    if (!dataSource?.trim()) {
      die(
        `--data-source required for price conditions (above/below).\n` +
        `Pull OHLCV data first, then cite the evidence for the level.\n` +
        `Example: --data-source "14 weekly closes in \\$60k-\\$65k from 210w TradingView OHLCV"\n` +
        `Example: --data-source "200wMA \\$62,640 from TradingView 210 weekly bars"\n` +
        `No data source = no alert. Do not fabricate support levels.`
      );
    }
  }

  const finalReasoning = priceConditions.length > 0
    ? `${reasoning} [data: ${flag(args, "data-source")}]`
    : reasoning;

  const body: any = {
    symbol: symbol.toUpperCase(),
    reasoning: finalReasoning,
    desk,
    conditions: builtConditions,
    ...(link            ? { analysisLink: link }              : {}),
    ...(cooldown        ? { cooldownSec: parseInt(cooldown) } : {}),
    ...(channels.length ? { channels }                        : {}),
  };

  const job = await api(auth, "POST", "/alerts", body) as any;
  console.log(`\nadded alert:`);
  console.log(`  id:        ${job.id}`);
  console.log(`  symbol:    ${job.symbol}`);
  console.log(`  condition: ${job.conditions.map((c: any) => `${c.condition} @ ${c.value}`).join(", ")}`);
  console.log(`  reason:    ${job.reasoning}`);
  if (job.analysisLink) console.log(`  link:      ${job.analysisLink}`);
  if (job.channels?.length) console.log(`  channels:  ${job.channels.join(", ")}`);
  const emailChans = channels.filter(c => c.startsWith("email:"));
  if (emailChans.length)
    console.log(`\nEmail delivery: Brevo (primary, needs BREVO_API_KEY + ALERT_EMAIL_FROM) → ntfy-email → Resend → stdout, set where the checker runs. ALERT_EMAIL_FROM must be a verified sender; without it Brevo/Resend are skipped.`);
  console.log(`\nNotification → see bun mkt-alerts.ts subscribe for your ntfy URL`);

} else {
  die(`unknown command: ${sub}. Run with --help.`);
}
