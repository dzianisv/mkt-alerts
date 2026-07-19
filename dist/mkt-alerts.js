#!/usr/bin/env bun
// @bun

// mkt-alerts.ts
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var AUTH_PATH = join(homedir(), ".config", "mkt-watch", "auth.json");
function loadAuth() {
  if (!existsSync(AUTH_PATH))
    die(`Config not found: ${AUTH_PATH}
Run 'bash deploy.sh' first.`);
  return JSON.parse(readFileSync(AUTH_PATH, "utf8"));
}
function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}
function flagAll(args, name) {
  const out = [];
  for (let i = 0;i < args.length; i++)
    if (args[i] === `--${name}` && i + 1 < args.length)
      out.push(args[i + 1]);
  return out;
}
async function api(auth, method, path, body) {
  const res = await fetch(`${auth.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json"
    },
    ...body ? { body: JSON.stringify(body) } : {}
  });
  const data = await res.json();
  if (!res.ok)
    die(`API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
var args = process.argv.slice(2);
var sub = args[0];
if (!sub || sub === "--help" || sub === "-h") {
  console.log(`mkt-alerts \u2014 manage alerts on the remote mkt daemon

commands:
  subscribe                     print ntfy subscribe URL
  add     --symbol <SYM>        add an alert
          --condition <cond>    condition (below, above, rsi_below, \u2026); repeat for compound
          --value <num>         threshold; one per --condition
          --reason <text>       why you set this alert
          [--link <url>]        optional analysis URL in the notification
          [--cooldown <sec>]    re-alert after N seconds (default: one-shot)
          [--desk crypto|stocks]
          [--channel <spec>]    delivery channel; repeat for several. one of:
                                  email:you@example.com
                                  telegram-bot:@CryptoAiInvestor
                                  ntfy:my-topic   (default: your ntfy topic)
  list                          list active alerts
  remove  --id <id>             remove alert by ID

valid conditions:
  above, below, pct_up, pct_down,
  rsi_above, rsi_below, sma_cross_above, sma_cross_below,
  macd_cross, volume_above, stddev_above

config: ${AUTH_PATH}`);
  process.exit(0);
}
var auth = loadAuth();
if (sub === "subscribe") {
  const data = await api(auth, "GET", "/subscribe");
  console.log(`
\uD83D\uDCF2  Subscribe to alerts in the ntfy app:
`);
  console.log(`    ${data.subscribe_url}`);
  console.log(`
    iOS / Android: https://ntfy.sh/#download`);
  console.log(`    Browser:        ${data.subscribe_url}
`);
} else if (sub === "list") {
  const jobs = await api(auth, "GET", "/alerts");
  if (!jobs.length) {
    console.log("no alerts");
    process.exit(0);
  }
  console.log("ID".padEnd(36) + " SYMBOL".padEnd(10) + " CONDITIONS".padEnd(30) + " STATUS   REASON");
  console.log("\u2500".repeat(110));
  const now = new Date;
  for (const j of jobs) {
    const conds = j.conditions.map((c) => `${c.condition}@${c.value}`).join(",");
    const expired = j.expiry && new Date(j.expiry) < now;
    const status = j.fired ? "fired" : expired ? "expired" : "active";
    const reason = (j.reasoning ?? "").slice(0, 40);
    console.log(`${j.id.padEnd(36)} ${j.symbol.padEnd(9)} ${conds.padEnd(29)} ${status.padEnd(9)} ${reason}`);
    if (j.analysisLink)
      console.log(" ".repeat(37) + "\uD83D\uDCCA " + j.analysisLink);
  }
} else if (sub === "remove") {
  const id = flag(args, "id") ?? die("--id required");
  await api(auth, "DELETE", `/alerts/${id}`);
  console.log(`removed ${id}`);
} else if (sub === "add") {
  const symbol = flag(args, "symbol") ?? die("--symbol required");
  const reasoning = flag(args, "reason") ?? die("--reason required");
  const conditions = flagAll(args, "condition");
  const values = flagAll(args, "value");
  const desk = flag(args, "desk") ?? "crypto";
  const link = flag(args, "link");
  const cooldown = flag(args, "cooldown");
  const channels = flagAll(args, "channel");
  if (!conditions.length)
    die("--condition required");
  if (conditions.length !== values.length)
    die("each --condition needs a --value");
  const CHANNEL_PREFIXES = ["email:", "telegram:", "telegram-bot:", "ntfy:", "stdout"];
  for (const ch of channels) {
    if (!CHANNEL_PREFIXES.some((p) => ch === p || ch.startsWith(p)))
      die(`invalid --channel "${ch}". Use one of: ${CHANNEL_PREFIXES.join(", ")}<target>`);
    if (ch.startsWith("email:") && !/^email:[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ch))
      die(`invalid email recipient in "${ch}". Use --channel email:you@example.com`);
  }
  const priceConditions = conditions.filter((c) => c === "above" || c === "below");
  if (priceConditions.length > 0) {
    const dataSource = flag(args, "data-source");
    if (!dataSource?.trim()) {
      die(`--data-source required for price conditions (above/below).
` + `Pull OHLCV data first, then cite the evidence for the level.
` + `Example: --data-source "14 weekly closes in \\$60k-\\$65k from 210w TradingView OHLCV"
` + `Example: --data-source "200wMA \\$62,640 from TradingView 210 weekly bars"
` + `No data source = no alert. Do not fabricate support levels.`);
    }
  }
  const finalReasoning = priceConditions.length > 0 ? `${reasoning} [data: ${flag(args, "data-source")}]` : reasoning;
  const body = {
    symbol: symbol.toUpperCase(),
    reasoning: finalReasoning,
    desk,
    conditions: conditions.map((c, i) => ({ condition: c, value: parseFloat(values[i]) })),
    ...link ? { analysisLink: link } : {},
    ...cooldown ? { cooldownSec: parseInt(cooldown) } : {},
    ...channels.length ? { channels } : {}
  };
  const job = await api(auth, "POST", "/alerts", body);
  console.log(`
added alert:`);
  console.log(`  id:        ${job.id}`);
  console.log(`  symbol:    ${job.symbol}`);
  console.log(`  condition: ${job.conditions.map((c) => `${c.condition} @ ${c.value}`).join(", ")}`);
  console.log(`  reason:    ${job.reasoning}`);
  if (job.analysisLink)
    console.log(`  link:      ${job.analysisLink}`);
  if (job.channels?.length)
    console.log(`  channels:  ${job.channels.join(", ")}`);
  const emailChans = channels.filter((c) => c.startsWith("email:"));
  if (emailChans.length)
    console.log(`
Email delivery: Brevo (primary, needs BREVO_API_KEY + ALERT_EMAIL_FROM) \u2192 ntfy-email \u2192 Resend \u2192 stdout, set where the checker runs. ALERT_EMAIL_FROM must be a verified sender; without it Brevo/Resend are skipped.`);
  console.log(`
Notification \u2192 see bun mkt-alerts.ts subscribe for your ntfy URL`);
} else {
  die(`unknown command: ${sub}. Run with --help.`);
}
