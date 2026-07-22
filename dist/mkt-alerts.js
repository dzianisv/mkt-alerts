#!/usr/bin/env node

// mkt-alerts.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawn, execFileSync } from "child_process";
import { createServer } from "net";
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
var MKT_VERSION = "0.1.0";
var TRY_SYMBOL = "BTC-USD";
var mktDaemon = null;
function cleanupDaemon() {
  const d = mktDaemon;
  mktDaemon = null;
  if (d && d.pid && !d.killed) {
    try {
      d.kill("SIGTERM");
    } catch {}
  }
}
function tryCacheDir() {
  const dir = process.env.MKT_ALERTS_CACHE || join(homedir(), ".cache", "mkt-alerts");
  mkdirSync(dir, { recursive: true });
  return dir;
}
function mktAsset() {
  const p = process.platform;
  const a = process.arch;
  const map = {
    "darwin-arm64": "darwin_arm64",
    "darwin-x64": "darwin_amd64",
    "linux-x64": "linux_amd64",
    "linux-arm64": "linux_arm64",
    "win32-x64": "windows_amd64",
    "win32-arm64": "windows_arm64"
  };
  const asset = map[`${p}-${a}`];
  if (!asset)
    die(`'try' does not support this platform (${p}/${a}).
` + `Supported: darwin/arm64, darwin/x64, linux/x64, linux/arm64, win32/x64, win32/arm64.
` + `Install mkt manually from https://github.com/stxkxs/mkt/releases and follow the manual walkthrough in the README.`);
  return { asset, ext: p === "win32" ? "zip" : "tar.gz" };
}
async function ensureMkt() {
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
  let buf;
  try {
    const res = await fetch(url);
    if (!res.ok)
      die(`download failed: HTTP ${res.status} for ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    die(`download failed for ${url}: ${e.message}`);
  }
  const archivePath = join(dir, `mkt_${MKT_VERSION}_${asset}.${ext}`);
  writeFileSync(archivePath, buf);
  console.log(`done (${(buf.length / 1048576).toFixed(1)} MB)`);
  process.stdout.write(`\uD83D\uDCE6  Extracting … `);
  try {
    if (ext === "tar.gz") {
      try {
        execFileSync("tar", ["xzf", archivePath, "-C", dir, binName], { stdio: "ignore" });
      } catch {
        execFileSync("tar", ["xzf", archivePath, "-C", dir], { stdio: "ignore" });
      }
    } else {
      try {
        execFileSync("unzip", ["-o", archivePath, binName, "-d", dir], { stdio: "ignore" });
      } catch {
        execFileSync("unzip", ["-o", archivePath, "-d", dir], { stdio: "ignore" });
      }
    }
  } catch (e) {
    die(`extraction failed: ${e.message}`);
  }
  try {
    unlinkSync(archivePath);
  } catch {}
  if (!existsSync(binPath))
    die(`extraction did not produce ${binName} in ${dir}`);
  if (process.platform !== "win32")
    chmodSync(binPath, 493);
  console.log(`done → ${binPath}`);
  return binPath;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => port ? resolve(port) : reject(new Error("could not acquire a free port")));
    });
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function pollQuote(port, symbol, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!mktDaemon)
      throw new Error("mkt engine exited before serving a quote");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/quotes/${symbol}`);
      if (res.ok) {
        const data = await res.json();
        if (typeof data.price === "number" && data.price > 0)
          return data.price;
      }
    } catch {}
    process.stdout.write(".");
    await sleep(500);
  }
  throw new Error("timed out waiting for a live quote (20s)");
}
async function runTry() {
  console.log(`
\uD83D\uDE80  mkt-alerts try — zero-signup local demo
`);
  console.log(`    Downloads the mkt engine, runs a live price check on 127.0.0.1, and fires`);
  console.log(`    a DEMO alert against a real market price. No signup, no API key, no auth.json.`);
  console.log(`    One-shot local demo of the core evaluation loop — not a persistent daemon.
`);
  const binPath = await ensureMkt();
  process.stdout.write(`\uD83C\uDF31  Seeding watchlist (${TRY_SYMBOL}) … `);
  try {
    execFileSync(binPath, ["config", "add", TRY_SYMBOL], { stdio: "ignore", env: process.env });
    console.log("done");
  } catch (e) {
    die(`'mkt config add ${TRY_SYMBOL}' failed: ${e.message}`);
  }
  const port = await freePort();
  let daemonOutput = "";
  process.stdout.write(`⚙️   Starting local mkt engine on 127.0.0.1:${port} `);
  mktDaemon = spawn(binPath, ["daemon", "--listen", `127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
  mktDaemon.stdout?.on("data", (d) => daemonOutput += d.toString());
  mktDaemon.stderr?.on("data", (d) => daemonOutput += d.toString());
  mktDaemon.on("exit", () => {
    mktDaemon = null;
  });
  let price;
  try {
    price = await pollQuote(port, TRY_SYMBOL, 20000);
  } catch (e) {
    console.log("");
    cleanupDaemon();
    die(`${e.message}.
` + (daemonOutput.trim() ? `mkt engine output:
${daemonOutput.trim()}` : "The mkt engine produced no output."));
  }
  console.log(" live!");
  const threshold = Math.floor(price * 0.999 * 100) / 100;
  const fired = price > threshold;
  const p2 = price.toFixed(2);
  const t2 = threshold.toFixed(2);
  console.log("");
  if (fired) {
    console.log(`\uD83D\uDD14 ALERT FIRED — ${TRY_SYMBOL} is $${p2}, above your $${t2} threshold`);
    console.log(`   (live price from your local mkt engine, evaluated on 127.0.0.1, zero signup, zero API key)`);
  } else {
    console.log(`Quote is $${p2}; demo threshold $${t2} did not trigger.`);
  }
  cleanupDaemon();
  console.log(`
─────────────────────────────────────────────────────────────`);
  console.log(`What just happened: a real live ${TRY_SYMBOL} price was fetched by a local mkt`);
  console.log(`engine and evaluated with the same "above" rule the product uses. The engine`);
  console.log(`has now been stopped — nothing keeps running, and no alert was persisted.
`);
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
var args = process.argv.slice(2);
var sub = args[0];
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

valid conditions:
  above, below, pct_up, pct_down,
  rsi_above, rsi_below, sma_cross_above, sma_cross_below,
  macd_cross, volume_above, stddev_above, pine

config: ${AUTH_PATH}`);
  process.exit(0);
}
if (sub === "try") {
  process.on("exit", cleanupDaemon);
  process.on("SIGINT", () => {
    cleanupDaemon();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanupDaemon();
    process.exit(143);
  });
  await runTry();
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
  console.log("─".repeat(110));
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
  const pineFile = flag(args, "pine");
  const conditions = flagAll(args, "condition");
  const values = flagAll(args, "value");
  const desk = flag(args, "desk") ?? "crypto";
  const link = flag(args, "link");
  const cooldown = flag(args, "cooldown");
  const channels = flagAll(args, "channel");
  let builtConditions;
  if (pineFile) {
    if (!existsSync(pineFile))
      die(`--pine file not found: ${pineFile}`);
    const script = readFileSync(pineFile, "utf8");
    if (!script.trim())
      die(`--pine file is empty: ${pineFile}`);
    const fireOn = flag(args, "fire-on") ?? "cross_up";
    if (fireOn !== "cross_up" && fireOn !== "truthy")
      die(`--fire-on must be "cross_up" or "truthy"`);
    builtConditions = [{ condition: "pine", value: 0, script, signalPlot: flag(args, "signal") ?? "signal", fireOn }];
  } else {
    if (!conditions.length)
      die("--condition required (or use --pine <file>)");
    if (conditions.length !== values.length)
      die("each --condition needs a --value");
    builtConditions = conditions.map((c, i) => ({ condition: c, value: parseFloat(values[i]) }));
  }
  const CHANNEL_PREFIXES = ["email:", "telegram:", "telegram-bot:", "ntfy:", "stdout"];
  for (const ch of channels) {
    if (!CHANNEL_PREFIXES.some((p) => ch === p || ch.startsWith(p)))
      die(`invalid --channel "${ch}". Use one of: ${CHANNEL_PREFIXES.join(", ")}<target>`);
    if (ch.startsWith("email:") && !/^email:[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ch))
      die(`invalid email recipient in "${ch}". Use --channel email:you@example.com`);
  }
  const priceConditions = pineFile ? [] : conditions.filter((c) => c === "above" || c === "below");
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
    conditions: builtConditions,
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
Email delivery: Brevo (primary, needs BREVO_API_KEY + ALERT_EMAIL_FROM) → ntfy-email → Resend → stdout, set where the checker runs. ALERT_EMAIL_FROM must be a verified sender; without it Brevo/Resend are skipped.`);
  console.log(`
Notification → see bun mkt-alerts.ts subscribe for your ntfy URL`);
} else {
  die(`unknown command: ${sub}. Run with --help.`);
}
