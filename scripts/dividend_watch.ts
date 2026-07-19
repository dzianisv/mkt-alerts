#!/usr/bin/env bun
/**
 * dividend_watch.ts — headless daily payout monitor for the mkt daemon.
 *
 * Runs on the always-on GCP box via a systemd timer (the scheduled-task engine the
 * mkt Go daemon lacks — it only polls price/indicator conditions). No Chrome, no Mac:
 * pulls public data with plain fetch() (stockanalysis.com serves the box's IP with 200)
 * and pushes to the SAME channels the daemon already uses — ntfy (phone push) +
 * Telegram bot — read from /etc/mkt-daemon.env.
 *
 * Why watch dividends at all: for a liquidation stub like SITC, each special distribution
 * can re-price the stock by MORE or LESS than the cash paid. Dropping LESS than the payout
 * means holding through the distribution is accretive — the only real edge in owning one.
 * You can't know the textbook "ex-date wash" held without watching the actual reaction.
 *
 * Alerts (silent-unless-actionable):
 *   1. NEW distribution declared     → a history row not seen before
 *   2. UPCOMING ex-date <= N days    → last window to decide before going ex
 *   3. POST-EX price reaction        → did it drop less than the payout? (accretive)
 *
 * Env: NTFY_TOPIC, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ALERT_EMAIL (any subset; falls back to stdout).
 *      ALERT_EMAIL is the email RECIPIENT. Email delivery is layered with
 *      fall-through: Brevo (needs BREVO_API_KEY + a verified ALERT_EMAIL_FROM
 *      sender — never the recipient) → ntfy-native `Email:` header → stdout. When
 *      Brevo is not usable, email rides the ntfy push (single call). See deliverEmail().
 *      TICKERS (space/comma list, default "SITC"), UPCOMING_DAYS (default 14).
 * State: $STATE_DIR or ~/.local/state/dividend-watch/<TICKER>.json
 */

import { homedir } from "os";
import { join } from "path";
import { mkdir } from "fs/promises";

const NTFY_TOPIC = process.env.NTFY_TOPIC?.trim();
const NTFY_SERVER = process.env.NTFY_SERVER?.trim() || "https://ntfy.sh";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const TG_CHAT = process.env.TELEGRAM_CHAT_ID?.trim();
// When set, ntfy delivers each push ALSO as an email to this address (ntfy-native
// email — an `Email:` header on publish; no Resend/SMTP needed).
const ALERT_EMAIL = process.env.ALERT_EMAIL?.trim();
const STATE_DIR =
  process.env.STATE_DIR || join(homedir(), ".local/state/dividend-watch");
const UPCOMING_DAYS = Number(process.env.UPCOMING_DAYS || 14);
const UA = "Mozilla/5.0 (compatible; mkt-dividend-watch/1.0)";

interface DivRow { dt: string; amt: string; record: string; pay: string }
interface State {
  seenExDates: string[];
  reactedExDates: string[];
  priceLog: { date: string; price: number; prevClose: number; changePct: number }[];
  lastRun: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const amtNum = (a: string) => Number(String(a).replace(/[^0-9.]/g, "")) || 0;
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function pushNtfy(title: string, body: string, priority = "default"): Promise<void> {
  if (!NTFY_TOPIC) return;
  try {
    // HTTP headers must be latin-1: strip emoji/non-ASCII from Title. Emoji stays in body.
    const asciiTitle = title.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
    const headers: Record<string, string> = { Title: asciiTitle, Priority: priority, Tags: "moneybag" };
    // ntfy-native email fan-out is used ONLY when Brevo is not usable (no key or
    // no verified ALERT_EMAIL_FROM). When Brevo IS usable, deliverEmail() owns the
    // email and this call stays push-only, so there is no double push/email.
    const brevoUsable = !!(process.env.BREVO_API_KEY?.trim() && process.env.ALERT_EMAIL_FROM?.trim());
    if (ALERT_EMAIL && !brevoUsable) headers.Email = ALERT_EMAIL;
    // ntfy.sh requires an access token for the Email header (anonymous email is
    // blocked); push itself stays anonymous. Token only needed when emailing.
    const ntfyToken = process.env.NTFY_TOKEN?.trim();
    if (ntfyToken) headers.Authorization = `Bearer ${ntfyToken}`;
    await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
      method: "POST",
      headers,
      body,
    });
  } catch (e) {
    console.error("ntfy push failed:", e);
  }
}

export type DivEmailEnv = {
  brevoKey?: string;
  from?: string;
  to?: string;
  ntfyTopic?: string;
  ntfyServer?: string;
  ntfyToken?: string;
};

export function readEmailEnv(): DivEmailEnv {
  return {
    brevoKey: process.env.BREVO_API_KEY?.trim(),
    from: process.env.ALERT_EMAIL_FROM?.trim(),
    to: process.env.ALERT_EMAIL?.trim(),
    ntfyTopic: process.env.NTFY_TOPIC?.trim(),
    ntfyServer: process.env.NTFY_SERVER?.trim() || "https://ntfy.sh",
    ntfyToken: process.env.NTFY_TOKEN?.trim(),
  };
}

/**
 * Deliver a dividend-watch alert as email with layered fall-through mirroring
 * check.ts: Brevo (primary) -> ntfy-native email -> stdout. A transport that
 * returns a non-ok status OR throws falls through; the first success stops.
 *
 * Sender and recipient are separate: `to` is ALERT_EMAIL (recipient); the sender
 * is ALERT_EMAIL_FROM and is REQUIRED for Brevo — it never defaults to the
 * recipient. When Brevo is not usable (no key or no verified sender) this returns
 * "none" and pushNtfy() emails via its Email header instead, so email is never
 * sent twice. Returns which transport delivered (for tests).
 */
export async function deliverEmail(
  subject: string,
  body: string,
  env: DivEmailEnv = readEmailEnv(),
  fetchImpl: typeof fetch = fetch,
): Promise<"brevo" | "ntfy" | "stdout" | "none"> {
  const to = env.to;
  if (!to) return "none";                    // no recipient configured -> email off
  if (!env.brevoKey || !env.from) return "none"; // Brevo not usable -> pushNtfy handles email

  // 1. Brevo (primary).
  try {
    const res = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.brevoKey, "content-type": "application/json" },
      body: JSON.stringify({ sender: { email: env.from }, to: [{ email: to }], subject, textContent: body }),
    });
    if (res.ok) return "brevo";
    console.error(`dividend email: Brevo returned ${res.status} - falling back`);
  } catch (e) {
    console.error(`dividend email: Brevo threw (${e}) - falling back`);
  }

  // 2. ntfy-native email (fallback only — Brevo was attempted and failed).
  if (env.ntfyTopic) {
    try {
      const server = (env.ntfyServer || "https://ntfy.sh").replace(/\/+$/, "");
      const asciiSubject = subject.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
      const headers: Record<string, string> = { Title: asciiSubject, Email: to, Tags: "moneybag" };
      if (env.ntfyToken) headers.Authorization = `Bearer ${env.ntfyToken}`;
      const res = await fetchImpl(`${server}/${env.ntfyTopic}`, { method: "POST", headers, body });
      if (res.ok) return "ntfy";
      console.error(`dividend email(ntfy): status ${res.status} - falling back`);
    } catch (e) {
      console.error(`dividend email(ntfy): threw (${e}) - falling back`);
    }
  }

  // 3. stdout - never silently dropped.
  console.log(`[dividend email:stdout] ${subject}\n${body}`);
  return "stdout";
}

async function pushTelegram(text: string): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error("telegram push failed:", e);
  }
}

async function notify(title: string, body: string, priority = "default"): Promise<void> {
  const emailEnv = readEmailEnv();
  const brevoUsable = !!(emailEnv.brevoKey && emailEnv.from && emailEnv.to);
  const anyChannel = NTFY_TOPIC || (TG_TOKEN && TG_CHAT) || brevoUsable;
  if (!anyChannel) {
    console.log(`[notify:stdout] ${title}\n${body}`);
    return;
  }
  await Promise.all([
    pushNtfy(title, body, priority),
    pushTelegram(`${title}\n\n${body}`),
    deliverEmail(title, body, emailEnv),
  ]);
}

async function loadState(ticker: string): Promise<State> {
  const f = Bun.file(join(STATE_DIR, `${ticker}.json`));
  if (await f.exists()) {
    try { return (await f.json()) as State; } catch {}
  }
  return { seenExDates: [], reactedExDates: [], priceLog: [], lastRun: "" };
}
async function saveState(ticker: string, s: State): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await Bun.write(join(STATE_DIR, `${ticker}.json`), JSON.stringify(s, null, 2));
}

async function processTicker(ticker: string, forceSummary: boolean): Promise<void> {
  const div = await getJSON<{ data: { history: DivRow[]; infoTable: any } }>(
    `https://stockanalysis.com/api/symbol/s/${ticker}/dividend`
  );
  const quote = await getJSON<{ data: { p: number; cl: number; cp: number; td: string } }>(
    `https://stockanalysis.com/api/quotes/s/${ticker}`
  );
  if (!div?.data || !quote?.data) {
    console.error(`[${ticker}] fetch failed (div=${!!div} quote=${!!quote})`);
    await notify(`⚠️ dividend-watch ${ticker}`, `data fetch failed on ${today()} — check the daemon.`, "high");
    return;
  }

  const history = div.data.history || [];
  const q = quote.data;
  const st = await loadState(ticker);
  const seen = new Set(st.seenExDates);
  const reacted = new Set(st.reactedExDates);
  const now = today();
  const alerts: string[] = [];

  // 1) NEW distributions — skip the whole backlog on first run (seed baseline).
  const firstRun = st.seenExDates.length === 0;
  if (!firstRun) {
    for (const r of history.filter((r) => !seen.has(r.dt)))
      alerts.push(`🆕 NEW distribution: ${r.amt} | ex ${r.dt} | record ${r.record} | pay ${r.pay}`);
  }
  for (const r of history) seen.add(r.dt);

  // 2) UPCOMING ex-date within the window.
  for (const r of history) {
    const d = daysBetween(r.dt, now);
    if (d >= 0 && d <= UPCOMING_DAYS)
      alerts.push(`⏰ ex-date in ${d}d (${r.dt}): ${r.amt}. Hold through the record date to keep this payout, then you can sell.`);
  }

  // 3) POST-EX reaction — did the drop beat the payout?
  const past = history.filter((r) => daysBetween(now, r.dt) >= 0).sort((a, b) => Date.parse(b.dt) - Date.parse(a.dt));
  const lastEx = past[0];
  if (lastEx && Math.abs(daysBetween(now, lastEx.dt)) <= 1 && !reacted.has(lastEx.dt)) {
    const payout = amtNum(lastEx.amt);
    const drop = q.cl - q.p;
    if (payout > 0) {
      const captured = (((payout - drop) / payout) * 100).toFixed(0);
      alerts.push(
        drop < payout
          ? `📉 post-ex (${lastEx.dt}): dropped $${drop.toFixed(2)} vs $${payout.toFixed(2)} payout → held ${captured}% of the cash (accretive to hold through it). Price $${q.p}.`
          : `📉 post-ex (${lastEx.dt}): dropped $${drop.toFixed(2)} vs $${payout.toFixed(2)} payout → full/over-adjust, no edge from holding. Price $${q.p}.`
      );
    }
    reacted.add(lastEx.dt);
  }

  if (!st.priceLog.some((p) => p.date === q.td))
    st.priceLog.push({ date: q.td, price: q.p, prevClose: q.cl, changePct: q.cp });
  st.priceLog = st.priceLog.slice(-400);
  st.seenExDates = [...seen].sort();
  st.reactedExDates = [...reacted].sort();
  st.lastRun = now;
  await saveState(ticker, st);

  const info = div.data.infoTable || {};
  const summary = `${ticker} $${q.p} (${q.cp >= 0 ? "+" : ""}${q.cp}%) | last ex ${info.exdiv || "?"} | annual ${info.annual || "?"} | ${history.length} distributions`;
  console.log(`[${now}] ${summary}${firstRun ? " (seeded baseline)" : ""}`);

  if (alerts.length) {
    await notify(`🔔 dividend-watch ${ticker} ${now}`, `${summary}\n\n${alerts.join("\n\n")}`, "high");
  } else if (forceSummary) {
    await notify(`ℹ️ dividend-watch ${ticker} ${now}`, `no change.\n${summary}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const forceSummary = argv.includes("--summary");
  let tickers = argv.filter((a) => !a.startsWith("--")).map((t) => t.toUpperCase());
  if (tickers.length === 0)
    tickers = (process.env.TICKERS || "SITC").split(/[,\s]+/).filter(Boolean).map((t) => t.toUpperCase());
  for (const t of tickers) {
    try { await processTicker(t, forceSummary); }
    catch (e) { console.error(`[${t}] error:`, e); }
  }
}

if (import.meta.main) {
  main();
}
