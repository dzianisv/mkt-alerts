#!/usr/bin/env bun
import { loadJobs, markFired, isActive, type AlertJob, type Cond } from "./store.ts";
import { rsi, macd, sma } from "./indicators.ts";

const MKT_BIN = `${process.env.HOME}/.local/bin/mkt`;

export type JobData = {
  price: number;
  changePct?: number; // e.g. -2.30 for -2.30%
  closes?: number[];
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
    .map(r => `${r.cond.condition}:${r.cond.value}=${r.fires ? "✓" : "✗"}(price=${data.price})`)
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

// ── Message building ────────────────────────────────────────────────────────
//
// A fired alert produces one AlertMessage. `text` is the compact single-string
// form used by push channels (stdout/ntfy/telegram/telegram-bot). Email uses
// `subject` (symbol + condition) and `body` (reason + current value + trigger)
// so the thesis survives in an inbox-friendly shape.

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

// ── Email transport (Resend HTTP API) ─────────────────────────────────────────

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
 * Send one email via Resend. Pure w.r.t. env: caller supplies apiKey/from and
 * may inject fetchImpl so tests assert the payload without a real send.
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

/** Send a fired alert over one channel spec (single prefix:value token). */
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
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      body: msg.text,
      headers: { "Content-Type": "text/plain", Title: msg.subject },
    });
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
    // Primary path: ntfy-native email. Publishing to the existing ntfy topic
    // with an `Email:` header makes ntfy deliver the message as an email — no
    // Resend account, API key, or verified domain required. Reuses NTFY_TOPIC,
    // so email rides the same channel already deployed for phone push.
    const topic = process.env.NTFY_TOPIC?.trim();
    if (topic) {
      const server = (process.env.NTFY_SERVER?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
      // HTTP headers must be latin-1: strip non-ASCII (emoji) from the Title.
      const asciiSubject = msg.subject.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
      const headers: Record<string, string> = { "Content-Type": "text/plain", Title: asciiSubject, Email: to };
      // ntfy.sh no longer permits ANONYMOUS email sending — publishing with an
      // Email header requires an access token from a (free) ntfy account. Push
      // still works anonymously; only the email fan-out needs this token.
      const token = process.env.NTFY_TOKEN?.trim();
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${server}/${topic}`, { method: "POST", headers, body: msg.body });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error(`email(ntfy): ${server}/${topic} → status ${res.status} for ${to} ${detail}`.trim());
      }
      return;
    }
    // Fallback: Resend HTTP API (heavier — needs account + API key + verified domain).
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn("⚠️  email: no NTFY_TOPIC and no RESEND_API_KEY — falling back to stdout");
      console.log(`${msg.subject}\n${msg.body}`);
      return;
    }
    const from = process.env.ALERT_EMAIL_FROM ?? process.env.EMAIL_FROM ?? "alerts@resend.dev";
    const { ok, status } = await sendEmail({ to, subject: msg.subject, body: msg.body, apiKey, from });
    if (!ok) console.error(`email: Resend returned ${status} for ${to}`);
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
      data = { price, changePct, closes };
    } catch (e) {
      console.error(`[${job.id}] error fetching data: ${e}`);
      continue;
    }

    const { fires, detail } = evaluateJob(job, data);

    if (fires) {
      const ts = now.toISOString();
      const msg = buildAlertMessage(job, data.price, ts);

      console.log(`[${job.id}] FIRED — ${detail}`);

      if (!dryRun) {
        await notify(job.channel, msg);
        markFired(job.id, ts);
      } else {
        console.log(`  [dry-run] would notify ${job.channel}:`);
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
