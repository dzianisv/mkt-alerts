#!/usr/bin/env bun
import { loadJobs, markFired, isActive, resolveChannelSpec, type AlertJob, type Cond } from "./store.ts";
import { rsi, macd, sma } from "./indicators.ts";

const MKT_BIN = `${process.env.HOME}/.local/bin/mkt`;

// Pine conditions are evaluated by an isolated AGPL subprocess (pine-runner/),
// resolved relative to this file so the same layout works locally and on the VM
// (scripts/ and pine-runner/ are siblings in both). Override with PINE_RUNNER.
const PINE_RUNNER = process.env.PINE_RUNNER ?? new URL("../pine-runner/run.ts", import.meta.url).pathname;

export type JobData = {
  price: number;
  changePct?: number; // e.g. -2.30 for -2.30%
  closes?: number[];
  // Pine signals are pre-computed out-of-process (main loop) and keyed by cond
  // identity, mirroring how `closes` are pre-fetched so evalCond stays pure.
  pineSignals?: Map<Cond, boolean>;
};

/** Evaluate a single condition against provided data. Returns true if condition fires. */
function evalCond(cond: Cond, data: JobData): boolean {
  const { condition, value, period } = cond;
  const { price, changePct, closes } = data;

  switch (condition) {
    case "above": return price > value;
    case "below": return price < value;
    case "pct_up": return (changePct ?? 0) >= value;
    case "pct_down": return (changePct ?? 0) <= -Math.abs(value);
    case "volume_above": return false; // volume not available in current data path
    case "stddev_above": return false; // requires additional computation

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
      // fires when histogram flips sign (any direction)
      return (m.prevHist < 0 && m.hist > 0) || (m.prevHist > 0 && m.hist < 0);
    }
    case "pine":
      // Pre-computed by the main loop via the isolated pine-runner subprocess and
      // passed in through data.pineSignals (keyed by cond identity).
      return data.pineSignals?.get(cond) ?? false;
    default:
      return false;
  }
}

/** Pure: evaluate a job given pre-fetched data. Returns { fires, reason }. */
export function evaluateJob(job: AlertJob, data: JobData): { fires: boolean; detail: string } {
  const results = job.conditions.map(c => ({
    cond: c,
    fires: evalCond(c, data),
  }));

  const mode = job.match ?? (job.conditions.length > 1 ? "all" : "all");
  let fires: boolean;

  if (mode === "any") {
    fires = results.some(r => r.fires);
  } else if (mode === "sequence") {
    // TODO: v1 treats sequence like "all"; proper ordering requires state across runs
    fires = results.every(r => r.fires);
  } else {
    // "all" (default)
    fires = results.every(r => r.fires);
  }

  const detail = results
    .map(r => {
      const label = r.cond.condition === "pine"
        ? `pine:${r.cond.signalPlot ?? "signal"}`
        : `${r.cond.condition}:${r.cond.value}`;
      return `${label}=${r.fires ? "✓" : "✗"}(price=${data.price})`;
    })
    .join(", ");

  return { fires, detail };
}

/** Fetch current price and change% via mkt mcp get_quote. */
async function fetchPrice(symbol: string): Promise<{ price: number; changePct?: number }> {
  const mcpLines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_quote", arguments: { symbol } } }),
  ].join("\n") + "\n";

  const proc = Bun.spawn([MKT_BIN, "mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  });

  proc.stdin.write(mcpLines);
  proc.stdin.end();

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  // Parse newline-delimited JSON; find the tools/call response (id=2)
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.id === 2 && obj.result?.content?.[0]?.text) {
        // "BTC-USD: $60184.2800 (as of ...)"
        const m = obj.result.content[0].text.match(/\$([0-9,.]+)/);
        if (m) return { price: parseFloat(m[1].replace(/,/g, "")) };
      }
    } catch {}
  }
  throw new Error(`could not parse price for ${symbol}`);
}

/**
 * Fetch OHLCV closes via mkt mcp query_history.
 * Uses `limit` bars (default 60 to give enough data for MACD 26+9=35 bars minimum).
 */
async function fetchCloses(symbol: string, limit = 60): Promise<number[]> {
  const mcpLines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "query_history", arguments: { symbol, limit } } }),
  ].join("\n") + "\n";

  const proc = Bun.spawn([MKT_BIN, "mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  });

  proc.stdin.write(mcpLines);
  proc.stdin.end();

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.id === 2 && obj.result?.content?.[0]?.text) {
        // Parse lines like "  2026-06-21 O=... H=... L=... C=60178.02 V=..."
        const text: string = obj.result.content[0].text;
        const closes: number[] = [];
        for (const row of text.split("\n")) {
          const m = row.match(/C=([0-9.]+)/);
          if (m) closes.push(parseFloat(m[1]));
        }
        return closes;
      }
    } catch {}
  }
  throw new Error(`could not fetch closes for ${symbol}`);
}

type Candle = { open: number; high: number; low: number; close: number; volume: number; openTime: number };

/**
 * Fetch OHLCV candles via mkt mcp query_history. Pine needs full OHLCV (not just
 * closes), oldest-first, shaped exactly as PineTS expects.
 */
async function fetchOHLCV(symbol: string, limit = 120): Promise<Candle[]> {
  const mcpLines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "query_history", arguments: { symbol, limit } } }),
  ].join("\n") + "\n";

  const proc = Bun.spawn([MKT_BIN, "mcp"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  });
  proc.stdin.write(mcpLines);
  proc.stdin.end();
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  const re = /(\d{4}-\d{2}-\d{2})\s+O=([0-9.]+)\s+H=([0-9.]+)\s+L=([0-9.]+)\s+C=([0-9.]+)\s+V=([0-9.]+)/;
  for (const line of output.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: any;
    try { obj = JSON.parse(t); } catch { continue; }
    if (obj.id === 2 && obj.result?.content?.[0]?.text) {
      const text: string = obj.result.content[0].text;
      const candles: Candle[] = [];
      for (const row of text.split("\n")) {
        const m = row.match(re);
        if (m) candles.push({
          openTime: new Date(`${m[1]}T00:00:00Z`).getTime(),
          open: parseFloat(m[2]), high: parseFloat(m[3]), low: parseFloat(m[4]),
          close: parseFloat(m[5]), volume: parseFloat(m[6]),
        });
      }
      if (!candles.length) throw new Error(`no OHLCV rows parsed for ${symbol}`);
      return candles;
    }
  }
  throw new Error(`could not fetch OHLCV for ${symbol}`);
}

type PineSignal = { crossedUp: boolean; crossedDown: boolean; truthy: boolean; last: number; prev: number | null };

/** Evaluate a Pine script's signal plot via the isolated pine-runner subprocess. */
async function runPineSignal(script: string, candles: Candle[], signalPlot: string): Promise<PineSignal> {
  const proc = Bun.spawn(["bun", PINE_RUNNER], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  proc.stdin.write(JSON.stringify({ script, candles, signalPlot }));
  proc.stdin.end();
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const lastLine = out.trim().split("\n").filter(Boolean).pop() ?? "";
  let res: any;
  try { res = JSON.parse(lastLine); }
  catch { throw new Error(`pine-runner bad output: ${(out || err || "").slice(0, 500)}`); }
  if (!res.ok) throw new Error(res.error || err || "pine-runner failed");
  return { crossedUp: !!res.crossedUp, crossedDown: !!res.crossedDown, truthy: !!res.truthy, last: res.last, prev: res.prev ?? null };
}

// ── Message building ────────────────────────────────────────────────────────
//
// A fired alert produces one AlertMessage. `text` is the compact single-string
// form used by push channels (stdout/ntfy/telegram/telegram-bot). Email uses
// `subject` (symbol + condition) and `body` (reason + current value + trigger)
// so the thesis survives in an inbox-friendly shape. Email transport is layered
// with fall-through: Brevo (primary, BREVO_API_KEY) → ntfy-native email
// (NTFY_TOPIC) → Resend (RESEND_API_KEY) → stdout. A transport that fails
// (non-ok status or thrown error) falls through to the next; the first success
// stops the chain. See deliverEmail().

export type AlertMessage = { subject: string; body: string; text: string };

/** Pure: build subject/body/text for a fired job. Exported for tests. */
export function buildAlertMessage(job: AlertJob, price: number, isoTs: string): AlertMessage {
  const trigger = job.conditions.map(c => `${c.condition} @ ${c.value}`).join(" AND ");
  const subject = `🔔 ${job.symbol}: ${trigger}`;

  const bodyLines = [
    `${job.symbol} alert fired at ${isoTs}`,
    ``,
    `Trigger:  ${trigger}`,
    `Current:  ${price}`,
    ``,
    `Why: ${job.reasoning}`,
  ];
  if (job.analysisLink) bodyLines.push(``, `Analysis: ${job.analysisLink}`);
  const body = bodyLines.join("\n");

  // Compact form kept ~backward-compatible with the previous ntfy/telegram text.
  const text =
    `🔔 mkt alert — ${job.symbol} fired @ ${price} (${isoTs})\n` +
    `Conditions: ${trigger}\n` +
    `WHY: ${job.reasoning}` +
    (job.analysisLink ? `\n📊 Analysis: ${job.analysisLink}` : "");

  return { subject, body, text };
}

// ── Email transports ──────────────────────────────────────────────────────────

export type EmailOpts = {
  to: string;
  subject: string;
  body: string;
  apiKey: string;
  from: string;
  /** Injectable for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Send one email via Brevo's transactional email HTTP API — the PRIMARY email
 * transport. Plain POST, matching how the repo already sends Telegram/ntfy. Pure
 * w.r.t. env: caller supplies apiKey/from and may inject fetchImpl so tests
 * assert the payload without a real send. Brevo free tier is ~300 emails/day and
 * appends a "Sent with Brevo" footer.
 */
export async function sendBrevoEmail(opts: EmailOpts): Promise<{ ok: boolean; status: number }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": opts.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      sender: { email: opts.from },
      to: [{ email: opts.to }],
      subject: opts.subject,
      textContent: opts.body,
    }),
  });
  return { ok: res.ok, status: res.status };
}

/**
 * Send one email via Resend. FALLBACK transport (used only when Brevo and ntfy
 * are both unavailable). Pure w.r.t. env: caller supplies apiKey/from and may
 * inject fetchImpl so tests assert the payload without a real send.
 */
export async function sendEmail(opts: EmailOpts): Promise<{ ok: boolean; status: number }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: opts.from, to: [opts.to], subject: opts.subject, text: opts.body }),
  });
  return { ok: res.ok, status: res.status };
}

/**
 * Deliver one email with layered fallback: Brevo -> ntfy-native email -> Resend ->
 * stdout. A transport that returns a non-ok status OR throws (network error)
 * falls through to the next; the first success stops the chain. stdout is the
 * final guarantee -- an alert is never silently dropped.
 *
 * Sender and recipient are separate. `to` is the recipient (from the channel
 * spec); the sender is ALERT_EMAIL_FROM and is REQUIRED for Brevo and Resend. It
 * never defaults to the recipient or to a hard-coded address -- an unverified
 * "from" is rejected by the ESP, so that transport is skipped rather than sent
 * from a bad address (ntfy-email carries no sender, so it still runs).
 */
export async function deliverEmail(to: string, msg: AlertMessage): Promise<void> {
  const from = process.env.ALERT_EMAIL_FROM?.trim();

  // 1. Brevo (primary transport).
  const brevoKey = process.env.BREVO_API_KEY?.trim();
  if (brevoKey) {
    if (!from) {
      console.error("email: BREVO_API_KEY set but ALERT_EMAIL_FROM missing - skipping Brevo (refusing to send from an unverified address)");
    } else {
      try {
        const { ok, status } = await sendBrevoEmail({ to, subject: msg.subject, body: msg.body, apiKey: brevoKey, from });
        if (ok) return;
        console.error(`email: Brevo returned ${status} for ${to} - falling back`);
      } catch (e) {
        console.error(`email: Brevo threw for ${to} (${e}) - falling back`);
      }
    }
  }

  // 2. ntfy-native email - publish to the topic with an `Email:` header; ntfy
  //    delivers it as an email. No verified sender needed.
  const topic = process.env.NTFY_TOPIC?.trim();
  if (topic) {
    try {
      const server = (process.env.NTFY_SERVER?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
      // HTTP headers must be latin-1: strip non-ASCII (emoji) from the Title.
      const headers: Record<string, string> = { "Content-Type": "text/plain", Title: asciiHeader(msg.subject), Email: to };
      // ntfy.sh blocks ANONYMOUS email sending - the Email header needs a token.
      const token = process.env.NTFY_TOKEN?.trim();
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${server}/${topic}`, { method: "POST", headers, body: msg.body });
      if (res.ok) return;
      const detail = await res.text().catch(() => "");
      console.error(`email(ntfy): ${server}/${topic} -> status ${res.status} for ${to} ${detail}`.trim() + " - falling back");
    } catch (e) {
      console.error(`email(ntfy): threw for ${to} (${e}) - falling back`);
    }
  }

  // 3. Resend (last-resort transport) - needs API key AND a verified sender.
  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (resendKey) {
    if (!from) {
      console.error("email: RESEND_API_KEY set but ALERT_EMAIL_FROM missing - skipping Resend");
    } else {
      try {
        const { ok, status } = await sendEmail({ to, subject: msg.subject, body: msg.body, apiKey: resendKey, from });
        if (ok) return;
        console.error(`email: Resend returned ${status} for ${to} - falling back`);
      } catch (e) {
        console.error(`email: Resend threw for ${to} (${e}) - falling back`);
      }
    }
  }

  // 4. stdout - never silently dropped.
  console.warn("email: all transports unavailable or failed - falling back to stdout");
  console.log(`${msg.subject}\n${msg.body}`);
}

/** Send a fired alert over one channel spec (single prefix:value token). */
// HTTP header values must be latin-1; ntfy carries the alert subject in the
// `Title` header, so any emoji/unicode in the subject (e.g. the 🔔 prefix) makes
// Bun's fetch throw `Header 'Title' has invalid value`. Strip to printable ASCII.
export function asciiHeader(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
}

export async function notifyOne(channel: string, msg: AlertMessage): Promise<void> {
  if (channel === "stdout") {
    console.log(msg.text);
    return;
  }
  if (channel.startsWith("telegram:")) {
    const target = channel.slice("telegram:".length);
    const proc = Bun.spawn(
      ["python3", `${process.env.HOME}/.agents/skills/telegram-cli/telegram-cli.py`, "send", target, msg.text],
      { stdout: "inherit", stderr: "inherit" }
    );
    await proc.exited;
    return;
  }
  if (channel.startsWith("ntfy:")) {
    const topic = channel.slice("ntfy:".length);
    const server = (process.env.NTFY_SERVER?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
    const headers: Record<string, string> = { "Content-Type": "text/plain", Title: asciiHeader(msg.subject) };
    // Authenticate when a token is available so private topics work; harmless for
    // public topics (anonymous push is allowed either way).
    const token = process.env.NTFY_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${server}/${topic}`, { method: "POST", body: msg.text, headers });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ntfy ${server}/${topic} -> status ${res.status} ${detail}`.trim());
    }
    return;
  }
  // telegram-bot: uses the Bot API directly (no Telethon session required).
  // Needs TELEGRAM_BOT_TOKEN env var. Works from any server.
  if (channel.startsWith("telegram-bot:")) {
    const chatId = channel.slice("telegram-bot:".length);
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error("telegram-bot: TELEGRAM_BOT_TOKEN not set, falling back to stdout");
      console.log(msg.text);
      return;
    }
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg.text }),
    });
    return;
  }
  if (channel.startsWith("email:")) {
    const to = channel.slice("email:".length);
    await deliverEmail(to, msg);
    return;
  }
  console.log(`[channel:${channel}] ${msg.text}`);
}

/**
 * Send a fired alert over the job's configured channel(s).
 * Multiple channels are comma-separated, e.g. "email:you@x.com,telegram-bot:@chan".
 */
export async function notify(channelSpec: string, msg: AlertMessage): Promise<void> {
  const channels = channelSpec.split(",").map(s => s.trim()).filter(Boolean);
  if (!channels.length) { console.log(msg.text); return; }
  for (const channel of channels) {
    try {
      await notifyOne(channel, msg);
    } catch (e) {
      console.error(`[notify] channel "${channel}" failed: ${e}`);
    }
  }
}

/** True when the condition needs historical closes (indicators). */
function needsCloses(cond: Cond): boolean {
  return ["rsi_above", "rsi_below", "sma_cross_above", "sma_cross_below", "macd_cross"].includes(
    cond.condition
  );
}

/** True when the condition is a Pine Script signal (evaluated out-of-process). */
function isPine(cond: Cond): boolean {
  return cond.condition === "pine";
}

async function main() {
  // Check mkt is accessible
  const which = Bun.spawnSync(["which", "mkt"], {
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  });
  if (which.exitCode !== 0) {
    console.error("⚠️  mkt not found on PATH — install mkt and ensure ~/.local/bin is on PATH");
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  const idFilter = (() => {
    const i = process.argv.indexOf("--id");
    return i !== -1 ? process.argv[i + 1] : undefined;
  })();

  const jobs = loadJobs();
  const now = new Date();

  for (const job of jobs) {
    if (idFilter && job.id !== idFilter) continue;

    if (!isActive(job, now)) {
      const reason = job.fired ? "one-shot already fired" : job.expiry && new Date(job.expiry) < now ? "expired" : "cooldown";
      console.log(`[${job.id}] skipped (${reason})`);
      continue;
    }

    let data: JobData;
    try {
      const { price, changePct } = await fetchPrice(job.symbol);
      let closes: number[] | undefined;
      if (job.conditions.some(needsCloses)) {
        closes = await fetchCloses(job.symbol);
      }
      let pineSignals: Map<Cond, boolean> | undefined;
      const pineConds = job.conditions.filter(isPine);
      if (pineConds.length) {
        const candles = await fetchOHLCV(job.symbol);
        pineSignals = new Map<Cond, boolean>();
        for (const c of pineConds) {
          try {
            const sig = await runPineSignal(c.script!, candles, c.signalPlot ?? "signal");
            const fired = c.fireOn === "truthy" ? sig.truthy : sig.crossedUp;
            pineSignals.set(c, fired);
            console.log(`[${job.id}] pine ${c.signalPlot ?? "signal"} last=${sig.last} prev=${sig.prev} crossUp=${sig.crossedUp} truthy=${sig.truthy} → ${fired}`);
          } catch (e) {
            console.error(`[${job.id}] pine eval error: ${e}`);
            pineSignals.set(c, false);
          }
        }
      }
      data = { price, changePct, closes, pineSignals };
    } catch (e) {
      console.error(`[${job.id}] error fetching data: ${e}`);
      continue;
    }

    const { fires, detail } = evaluateJob(job, data);

    if (fires) {
      const ts = now.toISOString();
      const msg = buildAlertMessage(job, data.price, ts);

      console.log(`[${job.id}] FIRED — ${detail}`);

      const channelSpec = resolveChannelSpec(job);
      if (!dryRun) {
        await notify(channelSpec, msg);
        markFired(job.id, ts);
      } else {
        console.log(`  [dry-run] would notify ${channelSpec}:`);
        console.log(`  subject: ${msg.subject}`);
        console.log(`  ${msg.body.replace(/\n/g, "\n  ")}`);
      }
    } else {
      console.log(`[${job.id}] no-fire (${detail})`);
    }
  }
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(1); });
}
