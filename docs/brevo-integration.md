# Brevo email integration

Reference for the Brevo transactional-email channel used by `scripts/check.ts`
(the alert checker run by the `mkt-check` systemd timer on the `mkt-daemon` VM).

## What Brevo is used for

Brevo is the **primary email delivery channel** for fired alerts. When an alert
job has an `email:<addr>` channel, `check.ts` sends the notification as a real
email through Brevo's transactional HTTP API.

### Why Brevo

- **Deliverability** — a real transactional ESP, so mail lands in the inbox
  rather than being dropped like anonymous SMTP.
- **HTTP API fits the codebase** — sending is a plain `fetch` POST with a JSON
  body, exactly like the existing Telegram and ntfy channels. No SMTP client,
  no persistent connection, no extra dependency.
- **No verified domain required** — Brevo only needs a **validated sender
  address** (see below), not full domain DNS verification like Resend.
- **Free tier ~300 emails/day** — ample for alert volume.

Trade-off: the free tier appends a **"Sent with Brevo"** footer to every email.
Acceptable for internal alerts.

Channel precedence in `check.ts` for an `email:` channel — layered and
**fails through** on any non-2xx response OR thrown/network error, first success
stops the chain:
**Brevo (`BREVO_API_KEY` + `ALERT_EMAIL_FROM`) → ntfy-native email → Resend
(`RESEND_API_KEY` + `ALERT_EMAIL_FROM`) → stdout** (final guarantee — never
silently dropped). Orchestrated by `deliverEmail()` in `scripts/check.ts`.

## The API

`sendBrevoEmail()` in `scripts/check.ts` calls:

```
POST https://api.brevo.com/v3/smtp/email
Headers:
  api-key: <BREVO_API_KEY>
  content-type: application/json
Body:
  {
    "sender":      { "email": "<from>" },
    "to":          [ { "email": "<recipient>" } ],
    "subject":     "<alert subject>",
    "textContent": "<alert body>"
  }
```

Returns `{ ok, status }`. `sendBrevoEmail()` itself does not throw; the
`deliverEmail()` wrapper treats a non-2xx status **or** a thrown/network error as
failure and falls through to the next transport (ntfy-email → Resend → stdout).

## Environment variables

| Env var           | Meaning                          | Bitwarden item (`dev` collection) |
|-------------------|----------------------------------|-----------------------------------|
| `BREVO_API_KEY`   | Brevo transactional API key      | `mkt-daemon/brevo-api-key`        |
| `ALERT_EMAIL_FROM`| Verified sender ("from") address | `mkt-daemon/alert-email-from`     |
| `ALERT_EMAIL`     | Recipient for ntfy-native email  | `mkt-daemon/alert-recipient`      |

Notes:
- `ALERT_EMAIL_FROM` is **required** for Brevo and Resend and has **no default**.
  It must be a sender verified in the account (see below). When it is unset,
  Brevo and Resend are skipped entirely — an unverified "from" is rejected by the
  ESP — and delivery falls through to ntfy-email / stdout. It is never derived
  from `ALERT_EMAIL` (the recipient) or any hard-coded address.
- `mkt-daemon/brevo-password` in Bitwarden is the Brevo **account/SMTP login**
  password, kept for dashboard/rotation access; the runtime path uses the API
  key, not the password.
- Secrets live in Bitwarden (`dev` collection) under `mkt-daemon/*`; a local
  `.env` (gitignored) mirrors them for dev runs.

## How `deploy.sh` wires it up

`deploy.sh` Phase 0 reads the secrets from Bitwarden with `bw get password`
(`mkt-daemon/brevo-api-key`, `mkt-daemon/alert-recipient` → `ALERT_EMAIL`,
`mkt-daemon/alert-email-from` → `ALERT_EMAIL_FROM`), writes them into a temp env
file, and `scp`s it to the VM. It is installed as `/etc/mkt-daemon.env` with
`install -m 600` (no world-readable window) and the uploaded `/tmp` copy is
removed immediately (an `EXIT` trap is a backstop). Both `mkt-check.service` and
`mkt-api.service` load that file via `EnvironmentFile=/etc/mkt-daemon.env`, so
`BREVO_API_KEY` and the sender/recipient addresses are present in the process
environment when `check.ts` and `api.ts` run.

The `mkt-check` systemd timer (`OnCalendar=*:0/15`, `Persistent=true`) fires
`check.ts` every 15 minutes; it reads alert jobs from `MKT_ALERTS_STORE`, pulls
live prices, and for any fired job with an `email:` channel calls
`sendBrevoEmail()` using the env values above.

## Usage

Add an alert that emails you when it fires:

```
bun mkt-alerts.ts add --symbol BTC-USD --condition below --value 90000 \
  --channel email:you@example.com --reason 'support break'
```

The `email:you@example.com` channel routes through Brevo when `BREVO_API_KEY`
is set on the daemon.

## Verified sender requirement

Brevo will only send from an address that has been **validated as a sender** in
the Brevo dashboard. The project's verified sender is `vibeteaichnologies@gmail.com`;
it must be added and verified under **Senders, Domains & Dedicated IPs → Senders**
before any email will deliver, and `ALERT_EMAIL_FROM` must be set to it. Sends
from an unverified address are rejected by the API.

## Key rotation

1. Regenerate the API key in the Brevo dashboard
   (**SMTP & API → API Keys → generate**), revoking the old one.
2. Update the Bitwarden item `mkt-daemon/brevo-api-key` (`dev` collection) with
   the new value. Bitwarden is the source of truth.
3. Update the local `.env` mirror if used.
4. Re-run `deploy.sh` — it re-reads Bitwarden and pushes a fresh
   `/etc/mkt-daemon.env` to the VM, then restarts the units.
