# mkt-alerts

Price and indicator alert daemon — self-hosted on a **free GCP e2-micro VM**, delivered via **ntfy push** to your phone.

Deploys [mkt](https://github.com/stxkxs/mkt) as a headless engine behind a **Cloudflare Tunnel** (no open firewall ports).

```bash
# Subscribe — get your ntfy push URL (open in ntfy app on phone)
npx -y @vibetechnologies/mkt-alerts subscribe

# Add a price alert
npx -y @vibetechnologies/mkt-alerts add \
  --symbol BTC-USD \
  --condition below --value 90000 \
  --reason "Support break — invalidates bull thesis" \
  --link "https://notion.so/my-analysis"

# Add a compound alert (RSI + price)
npx -y @vibetechnologies/mkt-alerts add \
  --symbol AAPL \
  --condition rsi_below --value 30 \
  --condition below --value 200 \
  --reason "Oversold at key support" \
  --desk stocks

# List active alerts
npx -y @vibetechnologies/mkt-alerts list

# Remove an alert
npx -y @vibetechnologies/mkt-alerts remove --id <id>
```

---

## Install as a Claude Code skill

Agents (stocks-advisor, crypto-advisor, multi-lens-quorum) can set alerts automatically after analysis:

```bash
npx skills add github.com/dzianisv/mkt-alerts/ -s mkt-alerts -y
```

Or manually copy `.claude/skills/mkt-alerts/SKILL.md` into `~/.claude/skills/mkt-alerts/`.

---

## Deploy your own instance

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

---

## Setting alerts

Use the included CLI — no SSH needed after `deploy.sh` runs.

**Get your subscribe URL:**
```bash
bun mkt-alerts.ts subscribe
# → https://ntfy.sh/mkt-a3f9c1e72d4b8e3f
# Open ntfy app on your phone and subscribe to that URL
```

**Add an alert:**
```bash
bun mkt-alerts.ts add \
  --symbol BTC-USD \
  --condition below \
  --value 90000 \
  --reason "Support break — exit signal" \
  --link "https://your-analysis-url"
# channel defaults to your ntfy topic — no --channel needed
```

**List active alerts:**
```bash
bun mkt-alerts.ts list
```

**Remove an alert:**
```bash
bun mkt-alerts.ts remove --id <id>
```

Alerts are checked every 15 minutes. When a condition fires you get a push notification with the reasoning and analysis link.

---

## Alert conditions

| Condition | Meaning |
|---|---|
| `above` / `below` | price crosses threshold |
| `pct_up` / `pct_down` | price moves X% from current |
| `rsi_above` / `rsi_below` | RSI crosses value |
| `sma_cross_above` / `sma_cross_below` | price crosses SMA |
| `macd_cross` | MACD line crosses signal |

Supports stocks (`AAPL`, `CRM`) and crypto (`BTC-USD`, `ETH-USD`, `AAVE-USD`).

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
