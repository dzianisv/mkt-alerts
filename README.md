# mkt-alerts

**Self-hosted, programmable market alerts — run TradingView-style alerts (price, RSI, Pine Script v5) off-platform, with your own notifications (ntfy push, email, Telegram).**

[![npm version](https://img.shields.io/npm/v/@vibetechnologies/mkt-alerts.svg)](https://www.npmjs.com/package/@vibetechnologies/mkt-alerts)
[![npm downloads](https://img.shields.io/npm/dm/@vibetechnologies/mkt-alerts.svg)](https://www.npmjs.com/package/@vibetechnologies/mkt-alerts)
[![license: MIT](https://img.shields.io/npm/l/@vibetechnologies/mkt-alerts.svg)](https://github.com/dzianisv/mkt-alerts/blob/main/package.json)

Price and indicator alert daemon you run yourself — price thresholds, RSI/MACD/SMA conditions, compound rules, and full **Pine Script v5** custom indicators (evaluated **off TradingView**) — delivered via **ntfy push**, **email**, or **Telegram**. It's an alerting tool, not a TradingView charting/screener replacement.

## Try it locally in under 2 minutes

```bash
npx -y github:dzianisv/mkt-alerts try
```

Downloads the mkt engine, runs a live price check on localhost, and fires a demo alert — no signup, no API key, no manual clone. (Runs straight from the repo; the shorter `npx -y @vibetechnologies/mkt-alerts try` ships with the next npm release.)

### What `try` does under the hood (manual walkthrough)

The full loop — define an alert, evaluate it against a **live, no-API-key** quote, get notified — runs entirely on `127.0.0.1` with zero signup. Every command below was actually run and verified end-to-end on a real machine (real BTC-USD price from Coinbase, no VM, no Cloudflare, no account). Scripted back-to-back with `time`, the whole sequence below — binary download, config, daemon start, both `bun install`s, API start, alert add, and the checker firing it — measured **~1.5 seconds of actual command execution**; budget a couple of minutes to read and paste the six blocks:

```bash
# 0. Install the mkt engine (one-time). scripts/check.ts (step 6) shells out to
#    `mkt mcp` at this EXACT path, so install it there, not just anywhere on PATH:
mkdir -p ~/.local/bin
curl -L https://github.com/stxkxs/mkt/releases/download/v0.1.0/mkt_0.1.0_darwin_arm64.tar.gz | tar xz -C ~/.local/bin mkt
# darwin_arm64 above — swap for darwin_amd64 / linux_amd64 / linux_arm64 per `uname -s`/`uname -m`.
# Measured on this machine: 0.9s to download+extract. `go install github.com/stxkxs/mkt@latest`
# also works but measured ~15x slower (13.8s, cold module cache) and won't land the
# binary at ~/.local/bin unless you set GOBIN there first.

# 1. Seed a watchlist, then start mkt headless (NOT bare `mkt --listen` — that
#    launches the TUI too and crashes with no TTY in the background; use `daemon`):
~/.local/bin/mkt config add BTC-USD
~/.local/bin/mkt daemon --listen 127.0.0.1:8080 &

# 2. Verify a real, live, key-free quote (Coinbase for crypto, Yahoo for stocks):
curl http://127.0.0.1:8080/quotes/BTC-USD
# → {"symbol":"BTC-USD","price":65894.51,"change":-409.01,"change_pct":-0.62,"dir":"down"}

# 3. Clone, install deps, start the API layer that mkt-alerts.ts talks to.
#    Root package.json has zero deps; scripts/ has its own package.json (needs
#    `yaml`) — both installs are required or scripts/api.ts fails at startup:
git clone https://github.com/dzianisv/mkt-alerts && cd mkt-alerts
bun install && (cd scripts && bun install)
API_TOKEN=local-token NTFY_TOPIC=local-test MKT_ORIGIN=http://127.0.0.1:8080 PORT=9000 \
  bun scripts/api.ts &

# 4. Point the CLI at your local API instead of the hosted one:
mkdir -p ~/.config/mkt-watch
echo '{"apiUrl":"http://127.0.0.1:9000","token":"local-token"}' > ~/.config/mkt-watch/auth.json

# 5. Add an alert. Use --channel stdout so it's checker-managed (see note below):
bun mkt-alerts.ts add --symbol BTC-USD --condition above --value 0 \
  --reason "local trial" --data-source "local mkt quote" --channel stdout
bun mkt-alerts.ts list

# 6. Run the checker once — it fetches a fresh live quote itself (via `mkt mcp`,
#    independent of the daemon above) and fires to stdout:
bun scripts/check.ts
# → [<id>] FIRED — above:0=✓(price=65900.89)
#    🔔 mkt alert — BTC-USD fired @ 65900.89 ...
```

**Verified fix (PR #9):** any alert that *isn't* `--channel stdout/email:.../telegram:.../ntfy:<other-topic>` (i.e. the default push, matching the alert examples in "Deploy your own always-on instance" below) gets projected into `mkt`'s own config, which calls `restartMkt()` in `scripts/api.ts`. Before PR #9 this unconditionally sent `SIGTERM` to the local `mkt` process assuming systemd would restart it — on a plain dev box nothing does, killing the daemon for good. `restartMkt()` now calls `systemctl is-active --quiet mkt-daemon` first and **skips the SIGTERM entirely when unmanaged**, logging `restart skipped — no service manager detected` instead of killing the process. We re-verified this directly: added a default-channel alert, confirmed via `ps` that the local `mkt daemon` PID was unchanged before and after. New alert config still won't take effect until you restart `mkt` by hand locally — but the daemon itself no longer dies.

Production self-host (systemd, Cloudflare Tunnel, push notifications to your phone): see "Deploy your own always-on instance" below.

## Why mkt-alerts

- **Self-hosted, no lock-in.** Your VM (or your laptop), your API token, your alert data — not a vendor's account.
- **Pine Script v5 without TradingView.** Write real `ta.sma`/`ta.rsi`/custom logic; it runs on your own checker via an isolated PineTS subprocess, not on TradingView's servers or your alert plan's quota.
- **AI-agent friendly.** A plain CLI + HTTP API that an analysis agent (or you, by hand) can call right after it forms a thesis — see [`skills/mkt-alerts/SKILL.md`](skills/mkt-alerts/SKILL.md). It can even **wake your agent** when an alert fires — see the OpenClaw plugin below.
- **Evidence-gated, not vibes.** Price alerts (`above`/`below`) require a `--data-source` citing the OHLCV evidence for the level — the CLI refuses to store a fabricated support/resistance line.
- **Free.** Try it entirely on your own machine (above), or run it 24/7 on a GCP e2-micro free-tier instance; no per-alert or per-check paywall either way.

## Install as a Claude Code skill

Agents (stocks-advisor, crypto-advisor, multi-lens-quorum) can set alerts automatically after analysis:

```bash
npx skills add github.com/dzianisv/mkt-alerts/ -s mkt-alerts -y
```

Or manually copy `skills/mkt-alerts/SKILL.md` into `~/.claude/skills/mkt-alerts/`.

---

## Wake your AI agent on an alert (OpenClaw plugin)

**Your AI agent wakes up when the market hits your level.** Instead of only sending a push, the [OpenClaw](https://github.com/openclaw/openclaw) plugin runs the mkt-alerts checker *inside* your agent's gateway process — when an alert fires it **wakes the agent** so it acts on the condition automatically, on the last active channel.

```bash
openclaw plugins install ./integrations/openclaw
openclaw gateway restart
```

- **No GCP, no API keys.** Live prices from Coinbase (crypto) and Yahoo Finance (stocks) — public, key-free endpoints; never `mkt.agentlabs.cc`.
- **No extra process.** Runs as an in-gateway service (`registerService` + `setInterval`) — no separate systemd/pm2 unit.
- **Zero runtime deps** (Node built-ins only), MIT-licensed. Conditions: threshold / %-change / RSI / SMA-cross / MACD-cross.

Full setup, config schema, and the wake mechanism: [`integrations/openclaw/README.md`](integrations/openclaw/README.md).

---

## Deploy your own always-on instance (optional)

Want push notifications to your phone with the daemon running 24/7 instead of on your laptop? Deploy [mkt](https://github.com/stxkxs/mkt) as a headless engine on a **free GCP e2-micro VM** behind a **Cloudflare Tunnel** (no open firewall ports). Live demo: **https://mkt.agentlabs.cc**.

**Prerequisites (local):**
- `gcloud` CLI with a named config authenticated to your GCP account
- Bitwarden CLI (`bw`) unlocked — `source ~/.env.d/bitwarden.env`
- `curl`, `python3`

**Deploy:**
```bash
git clone https://github.com/dzianisv/mkt-alerts
cd mkt-alerts
bash deploy.sh
```

That's it. The script:
1. Creates the GCP VM (or starts it if stopped)
2. Upserts the Cloudflare DNS CNAME
3. Installs Go, Bun, mkt binary, systemd services on the VM
4. Verifies `https://mkt.agentlabs.cc/metrics` responds

Re-run any time to redeploy — idempotent.

**Once deployed, set alerts like this** — no SSH needed; the CLI talks to your VM over HTTPS using the token `deploy.sh` wrote to `~/.config/mkt-watch/auth.json`:

```bash
bun mkt-alerts.ts subscribe
# → https://ntfy.sh/mkt-a3f9c1e72d4b8e3f — open in the ntfy app on your phone

# A price alert — --data-source is required for above/below (evidence gate)
bun mkt-alerts.ts add \
  --symbol BTC-USD \
  --condition below --value 90000 \
  --reason "Support break — invalidates bull thesis" \
  --data-source "200wMA \$62,640 from TradingView 210 weekly bars" \
  --link "https://notion.so/my-analysis"
# channel defaults to your ntfy topic — no --channel needed

# A compound alert (RSI + price — both must be true)
bun mkt-alerts.ts add \
  --symbol AAPL \
  --condition rsi_below --value 30 \
  --condition below --value 200 \
  --reason "Oversold at key support" \
  --data-source "AAPL 200DMA 200.00, yfinance 1d" \
  --desk stocks

bun mkt-alerts.ts list
bun mkt-alerts.ts remove --id <id>
```

Alerts are checked every 15 minutes. When a condition fires you get a push notification with the reasoning and analysis link.

Prefer the published package over keeping a clone around? `npx -y @vibetechnologies/mkt-alerts <command>` works identically once `~/.config/mkt-watch/auth.json` exists (the file `deploy.sh` writes, or the one you wrote by hand in the local trial above).

---

## Pine Script v5 alerts — custom indicators, off TradingView

Any indicator or period the built-in conditions can't express (RSI is fixed at 14, SMA-cross at 20) can be written as **real Pine Script v5** and run against live OHLCV — no TradingView account needed. The checker evaluates your script every 15 minutes through an **isolated `pine-runner` sidecar** ([LuxAlgo PineTS](https://www.npmjs.com/package/pinets), AGPL-3.0, run as a subprocess — never bundled into the MIT-licensed CLI) and fires through the normal delivery pipeline.

Your script must `plot(<series>, "signal")` — one numeric series the checker reads per bar, encoded so **positive = fire**:

| `--fire-on` | Fires when | Use for |
|---|---|---|
| `cross_up` (default) | signal crosses 0 upward (`prev ≤ 0` → `last > 0`) | edge events — a cross, a break, fires once |
| `truthy` | signal is currently `> 0` | a state — "while oversold", fires on every check it's true |

```bash
# --pine replaces --condition/--value. --data-source is NOT required (the script is the evidence).
npx -y @vibetechnologies/mkt-alerts add \
  --symbol BTC-USD \
  --pine golden-cross.pine \
  --signal signal \
  --fire-on cross_up \
  --reason "SMA20 crossing above SMA50 confirms trend flip" \
  --channel email:you@example.com
```

`golden-cross.pine`:
```pine
//@version=5
indicator("golden cross")
fast = ta.sma(close, 20)
slow = ta.sma(close, 50)
plot(fast - slow, "signal")   // >0 when fast is above slow
```

More real, working examples (RSI on a custom period, a 200DMA break) are in [`skills/mkt-alerts/SKILL.md`](skills/mkt-alerts/SKILL.md#pine-script-alerts---pine--custom-indicators-off-tradingview).

## TradingView-style alerts without a TradingView account

mkt-alerts runs TradingView-style alert conditions without needing a TradingView account or subscription. It's an **alerting tool only** — no charts, screener, or analysis platform — so this compares alerting, not the full TradingView product:

| | mkt-alerts | TradingView alerts |
|---|---|---|
| Hosting | Self-hosted, your own machine or VM | TradingView's infrastructure |
| Cost | Free (your laptop, or a GCP e2-micro free tier) | Paid plans gate alert count/frequency |
| Custom Pine Script | Runs off-platform via an isolated PineTS sidecar | Requires an active TradingView plan |
| Data ownership | Your machine, your API token | Vendor-hosted account |
| Interface | CLI + HTTP API — scriptable, agent-callable | UI-driven |
| Delivery | ntfy push, email, Telegram bot | App push, email, webhooks (paid tiers) |

---

## Alert conditions

| Condition | Meaning |
|---|---|
| `above` / `below` | price crosses threshold (**requires `--data-source`**) |
| `pct_up` / `pct_down` | price moves X% from current |
| `rsi_above` / `rsi_below` | RSI(14) crosses value |
| `sma_cross_above` / `sma_cross_below` | price crosses SMA(20) |
| `macd_cross` | MACD line crosses signal |
| `pine` | custom Pine Script v5 signal — set via `--pine <file>`, not `--condition pine` directly (see [Pine Script alerts](#pine-script-v5-alerts--custom-indicators-off-tradingview)) |

Repeat `--condition`/`--value` pairs for a compound alert (all conditions must be true). Supports stocks (`AAPL`, `CRM`) and crypto (`BTC-USD`, `ETH-USD`, `AAVE-USD`). Built-in indicator periods are fixed (RSI 14, SMA 20) — for any other period or a custom indicator, use a [Pine Script alert](#pine-script-v5-alerts--custom-indicators-off-tradingview) or a computed price level.

---

## Delivery channels

### Telegram
The bot (`@OpenClawBotSupport_Bot`, token in Bitwarden as `mkt-daemon/telegram-bot-token`) posts to the `@CryptoAiInvestor` channel using the [Bot API](https://core.telegram.org/bots/api#sendmessage).

**How delivery works:**
1. `check.ts` calls `api.telegram.org/bot{TOKEN}/sendMessage` with `chat_id=@CryptoAiInvestor`
2. Telegram delivers the message to the channel

**Requirement: the bot must be an admin of the channel.**
Without admin rights the API returns `Unauthorized` and the alert is silently dropped.

To add the bot as admin:
1. Open `@CryptoAiInvestor` in Telegram
2. Channel Info → Administrators → Add Admin → search `@OpenClawBotSupport_Bot`
3. Grant "Post Messages" permission → Save

```bash
--channel telegram-bot:@CryptoAiInvestor
```

To post to a private chat instead (no admin needed — just start the bot):
```bash
--channel telegram-bot:@yourusername        # username
--channel telegram-bot:-1001234567890       # numeric chat ID
```

Message format:
```
🔔 BTC-USD crossed below 90000
Support break — exit signal
📊 https://your-analysis-url
```

**To use a different bot:** create one via [@BotFather](https://t.me/BotFather), add the token to Bitwarden as `mkt-daemon/telegram-bot-token`, redeploy.

### Email
Delivered via the [Brevo](https://www.brevo.com) transactional email HTTP API — a
plain `POST https://api.brevo.com/v3/smtp/email` (matching how alerts already POST
to Telegram/ntfy). No verified domain required, just a validated sender.
**Free tier: ~300 emails/day; Brevo free appends a "Sent with Brevo" footer.**

```bash
--channel email:you@example.com
```

Email transport is layered and **fails through** — each transport is tried in
order and, on a non-2xx response or a thrown/network error, the next one runs;
the first success stops the chain:
**Brevo** (`BREVO_API_KEY` + `ALERT_EMAIL_FROM`) → **ntfy-native email**
(`NTFY_TOPIC` + `Email:` header) → **Resend** (`RESEND_API_KEY` + `ALERT_EMAIL_FROM`)
→ **stdout** (never silently dropped).

**Subject** = symbol + condition (`🔔 BTC-USD: below @ 90000`).
**Body** = the alert's thesis + current value + trigger + analysis link:
```
BTC-USD alert fired at 2026-07-18T12:34:56.000Z

Trigger:  below @ 90000
Current:  88123.45

Why: Support break — invalidates bull thesis
Analysis: https://notion.so/...
```

**Required env vars** (set where the `check.ts` checker runs — see `.env.example`):

| Var | Purpose |
|---|---|
| `BREVO_API_KEY` | Brevo transactional email API key (primary transport). Store in Bitwarden as `mkt-daemon/brevo-api-key`. ~300 emails/day free. |
| `ALERT_EMAIL_FROM` | **Required** for Brevo/Resend — the sender ("from"), e.g. `vibeteaichnologies@gmail.com`. Must be a sender verified in the Brevo (or Resend) account. **No default**: if unset, Brevo and Resend are skipped (an unverified "from" is rejected by the ESP). Store in Bitwarden as `mkt-daemon/alert-email-from`. |
| `ALERT_EMAIL` | Recipient for ntfy-native email delivery. Store in Bitwarden as `mkt-daemon/alert-recipient`. Kept separate from the sender — a recipient is never reused as the "from". |
| `RESEND_API_KEY` | *(fallback only)* Resend API key, tried after Brevo and ntfy-email. Store in Bitwarden as `mkt-daemon/resend-api-key`. |

With none of `BREVO_API_KEY` / `NTFY_TOPIC` / `RESEND_API_KEY` usable, the alert falls back to stdout (never silently dropped). Brevo and Resend also fall through when `ALERT_EMAIL_FROM` is unset.

`deploy.sh` loads `mkt-daemon/brevo-api-key`, `mkt-daemon/alert-recipient` (→ `ALERT_EMAIL`) and `mkt-daemon/alert-email-from` (→ `ALERT_EMAIL_FROM`) from Bitwarden and ships them into `/etc/mkt-daemon.env` alongside the other daemon vars.

**Multiple channels** on one alert — repeat `--channel` (delivers to all):
```bash
--channel email:you@example.com --channel telegram-bot:@CryptoAiInvestor
```

### ntfy (no account needed)
```bash
--channel ntfy:your-topic-name
# subscribe on phone: https://ntfy.sh/your-topic-name
```

---

## API

| Endpoint | Description |
|---|---|
| `GET /metrics` | Uptime, symbol count, alert count |
| `GET /quotes` | All cached prices |
| `GET /quotes/BTC-USD` | Single symbol |
| `GET /alerts` | Active mkt-native alert rules |

```bash
curl https://mkt.agentlabs.cc/quotes/BTC-USD
```

---

## Logs

```bash
gcloud --configuration=bisonte compute ssh mkt-daemon \
  --zone=us-central1-a --project=mkt-daemon-alerts \
  --command="sudo journalctl -u mkt-daemon -f"
```
