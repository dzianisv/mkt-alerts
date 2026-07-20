---
description: Set, list, and remove price/indicator alerts on the self-hosted mkt daemon via the mkt-alerts CLI. Use when analysis concludes with a specific, deterministic entry/exit level worth monitoring (e.g. "alert me if BTC closes below 90000", "RSI oversold on AAPL"), or when turning a Watchlist trigger row into a live alert. Handles auth (bearer token from ~/.config/mkt-watch/auth.json), multi-channel delivery (ntfy push, email, Telegram), and the mandatory data-source evidence gate for price levels. Not for one-off "sell now" decisions (those have no monitorable condition) or calendar reminders — the daemon only evaluates price/indicator conditions.
---

# mkt-alerts

Manage alerts on a self-hosted [mkt](https://github.com/stxkxs/mkt) daemon (GCP e2-micro behind a Cloudflare Tunnel at `https://mkt.agentlabs.cc`). The daemon checks each alert every 15 min against live price/indicator data and notifies over the alert's channel(s) when the condition fires.

**What this is:** a deterministic price/indicator **trigger registry**. Every alert is `symbol + condition + value`.
**What this is NOT:** a place for "sell now" decisions (no condition to monitor) or date/calendar reminders (the daemon evaluates price/indicators, not dates).

## Prerequisites — auth

The CLI reads `~/.config/mkt-watch/auth.json` (written by `deploy.sh`, mode 600):
```json
{ "apiUrl": "https://mkt.agentlabs.cc", "token": "<API_TOKEN>" }
```
Every request sends `Authorization: Bearer <token>`. The write API (`POST`/`DELETE /alerts`) rejects a missing/wrong token with `401`. If the file is missing:
```bash
git clone https://github.com/dzianisv/mkt-alerts && cd mkt-alerts && bash deploy.sh
```
Never print, commit, or paste the token — it lives only in that 600-mode file. The real secrets (`API_TOKEN`, `BREVO_API_KEY`, etc.) live in Bitwarden `dev` and are shipped to the VM by `deploy.sh`.

## CLI

Run via the published package (`@vibetechnologies/mkt-alerts`) or the in-repo script (`bun mkt-alerts.ts`):

```bash
# 1. Get your ntfy subscribe URL (open in the ntfy app on your phone)
npx -y @vibetechnologies/mkt-alerts subscribe

# 2. Add a PRICE alert — --data-source is REQUIRED for above/below (see gate below)
npx -y @vibetechnologies/mkt-alerts add \
  --symbol BTC-USD \
  --condition below --value 90000 \
  --reason "WHY SET: support break invalidates the bull thesis; exit/reduce" \
  --data-source "200wMA 62,640 from TradingView 210 weekly bars, pulled 2026-07-20" \
  --link "https://notion.so/my-analysis" \
  --desk crypto \
  --channel email:you@example.com

# 3. List active alerts
npx -y @vibetechnologies/mkt-alerts list

# 4. Remove an alert
npx -y @vibetechnologies/mkt-alerts remove --id <id>
```

### Flags (`add`)

| Flag | Required | Meaning |
|---|---|---|
| `--symbol` | yes | Ticker, e.g. `BTC-USD`, `AAPL`. Upper-cased automatically. |
| `--condition` | yes | One of the conditions below. **Repeat** for compound (ALL must be true). |
| `--value` | yes | Threshold; **one `--value` per `--condition`**, same order. |
| `--reason` | yes | Why the alert exists. Start it `WHY SET:` (matches the Watchlist convention). |
| `--data-source` | **for `above`/`below`** | OHLCV evidence for the level. Hard gate — the CLI **exits** without it on a price condition. Appended to the stored reason as `[data: ...]`. |
| `--link` | no | Analysis/Notion URL, shown in the notification. |
| `--desk` | no | `crypto` (default) or `stocks`. |
| `--cooldown` | no | Seconds before re-alert. **Omit = one-shot** (fires once, then goes inactive). |
| `--channel` | no | Delivery route; **repeat** for several. Defaults to your ntfy topic. |

### Conditions

| Condition | Meaning | Value |
|---|---|---|
| `above` / `below` | price crosses threshold | price |
| `pct_up` / `pct_down` | price moves X% (vs prior change) | percent |
| `rsi_above` / `rsi_below` | RSI(14) crosses value | RSI level |
| `sma_cross_above` / `sma_cross_below` | price crosses SMA(20) | `0` |
| `macd_cross` | MACD histogram flips sign | `0` |

**CLI period limitation:** indicator periods are **not settable via the CLI** — `rsi_*` is fixed at 14 and `sma_cross_*` at 20. You cannot express `sma_cross_below(200)` or `rsi_below(21)` through the CLI. For a 200-day trend break, use a **price** condition at the computed 200DMA value instead:
```bash
--condition below --value 274.22 --data-source "AAPL 200DMA 274.22, yfinance 1d, pulled 2026-07-20"
```
(`volume_above` / `stddev_above` are accepted by the CLI but evaluate to no-fire in the current checker — don't rely on them.)

## Delivery channels (`--channel`)

Repeat `--channel` to fan out. Format is `prefix:target`:

| Channel | Example | Needs |
|---|---|---|
| ntfy (default) | `ntfy:my-topic` | nothing — subscribe on phone |
| email | `email:you@example.com` | ESP env on the checker (see below) |
| Telegram | `telegram-bot:@CryptoAiInvestor` | bot must be **channel admin** |
| stdout | `stdout` | nothing (logs only) |

```bash
--channel email:you@example.com --channel telegram-bot:@CryptoAiInvestor
```

### Email — how it's wired, and the delivery caveat

Email tries transports in order, falling through on failure: **Brevo** (`BREVO_API_KEY` + `ALERT_EMAIL_FROM`) → **ntfy-native email** (`NTFY_TOPIC` + `NTFY_TOKEN`) → **Resend** (`RESEND_API_KEY` + `ALERT_EMAIL_FROM`) → **stdout**. These env vars must be set **where `check.ts` runs** (the VM's `/etc/mkt-daemon.env`), not on your laptop.

- `ALERT_EMAIL_FROM` **must be a sender validated in the Brevo/Resend account** (e.g. `vibeteaichnologies@gmail.com`). If unset, Brevo/Resend are skipped.
- **Caveat — a fired alert does not prove an email arrived.** Brevo returns `201 Created` (queued) even when the sender is *not* validated, then drops the message asynchronously. The checker treats any 2xx as success and marks the one-shot alert `fired`, so a bad-sender config fails **silently**. After configuring email, send one test alert and confirm it in the inbox / Brevo event log before trusting the channel. Validated senders as of 2026-07: `vibeteaichnologies@gmail.com`, `info@vibebrowser.app`, `support@vibebrowser.app`.

## Agent workflow — Watchlist trigger → live alert

The Watchlist sheet is the canonical trigger registry; the mkt daemon is the engine that fires it. To arm a Watchlist row:

1. Confirm the row is a real **price/indicator** trigger (not a "sell now" decision or a date reminder). If it isn't, it doesn't belong on the daemon.
2. Map the sheet's `Conditions` cell to CLI flags, one-to-one:
   - `below:341` → `--condition below --value 341`
   - `rsi_below(14):30` → `--condition rsi_below --value 30`
   - `sma_cross_below(200):0` → **can't** (period gap) → convert to `--condition below --value <200DMA>` with a data-source.
3. Pull OHLCV first and pass it as `--data-source` for any `above`/`below` (the CLI enforces this).
4. Write `--reason` starting `WHY SET:` (mirrors the sheet's column-G rule).
5. Pass `--link` to the analysis/Notion page and `--channel` for delivery.
6. **Create the mkt job first, then upsert the sheet row** with the same intent (per the Watchlist lifecycle). On remove, delete the mkt job AND set the sheet row `Status = REMOVED`.

Example — arming the ESTC invalidation from the Watchlist:
```bash
npx -y @vibetechnologies/mkt-alerts add \
  --symbol ESTC \
  --condition below --value 55 \
  --reason "WHY SET: close below 55 gives back the recovery leg; exit before the 8/27 catalyst" \
  --data-source "ESTC 62.74; 3mo low 45.75; 200DMA 65.43, yfinance 1d, pulled 2026-07-20" \
  --desk stocks \
  --channel email:vibeteaichnologies@gmail.com
```

## Limitations to know

- No `--expiry` and no `--match any` via the CLI — compound conditions are always ALL/`and`, and alerts don't auto-expire (remove them manually).
- Indicator periods fixed (RSI 14, SMA 20) — see the period limitation above.
- One-shot by default: after firing once the alert stops. Use `--cooldown <sec>` for a repeating alert.

## Before finishing (self-check)

- [ ] Every `above`/`below` alert has a `--data-source` with real OHLCV evidence (no fabricated levels).
- [ ] `--reason` starts `WHY SET:`.
- [ ] The condition is genuinely monitorable — not a "sell now" decision or a calendar date.
- [ ] For a 200d/other-period trend break, you used a price level (not an un-periodable `sma_cross`).
- [ ] If `--channel email:`, you know the checker has a validated `ALERT_EMAIL_FROM`, and you'll verify the first delivery (a fired alert alone doesn't prove arrival).
