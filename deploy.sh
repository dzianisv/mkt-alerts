#!/usr/bin/env bash
# deploy.sh — redeploy mkt daemon on GCP e2-micro behind Cloudflare Tunnel
#
# Usage:
#   bash infra/mkt-daemon/deploy.sh
#
# Prereqs (local):
#   - gcloud with 'bisonte' named config authenticated
#   - bitwarden CLI (bw) unlocked: source ~/.env.d/bitwarden.env
#   - curl, python3, openssl
#
# Idempotent — safe to re-run. Skips already-done steps.
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
GCP_CONFIG="bisonte"
GCP_PROJECT="mkt-daemon-alerts"
GCP_ZONE="us-central1-a"
VM_NAME="mkt-daemon"
VM_TYPE="e2-micro"

CF_ACCOUNT_ID="c52033a95d560a9a183b016ceb1c107a"
CF_ZONE_ID="5fbeec0aa0dca842ab3b62fafb948fe9"
TUNNEL_NAME="mkt-daemon"
TUNNEL_HOST="mkt.agentlabs.cc"
MKT_LISTEN="127.0.0.1:9999"
MKT_COMMIT="0207dda"
MKT_LISTEN="127.0.0.1:8080"    # mkt daemon (internal)
API_PORT="9000"                 # mkt-api (Bun, faces Cloudflare tunnel)

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo "▶ $*"; }
ok()   { echo "  ✓ $*"; }
die()  { echo "  ✗ $*" >&2; exit 1; }

G()      { gcloud --configuration="$GCP_CONFIG" "$@"; }
SSH()    { G compute ssh "$VM_NAME" --zone="$GCP_ZONE" --project="$GCP_PROJECT" \
             --ssh-flag="-o ConnectTimeout=30 -o StrictHostKeyChecking=no" \
             --command="$1" 2>&1; }
SCP()    { G compute scp "$1" "$VM_NAME:$2" --zone="$GCP_ZONE" --project="$GCP_PROJECT" 2>&1; }
CF_API() { local m="$1" p="$2"; shift 2
           curl -sf -X "$m" "https://api.cloudflare.com/client/v4$p" \
             -H "Authorization: Bearer $CF_TOKEN" \
             -H "Content-Type: application/json" "$@"; }

# ── Phase 0: Secrets (from Bitwarden) ─────────────────────────────────────────
log "Phase 0: secrets"

source ~/.env.d/bitwarden.env 2>/dev/null || true
[[ "$(bw status 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')" == "unlocked" ]] \
  || die "Bitwarden locked — run: source ~/.env.d/bitwarden.env"

source ~/.env.d/cloudflare.env 2>/dev/null || true
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "CLOUDFLARE_API_TOKEN not set"
CF_TOKEN="$CLOUDFLARE_API_TOKEN"

TELEGRAM_BOT_TOKEN=$(bw get password "mkt-daemon/telegram-bot-token" 2>/dev/null) \
  || die "mkt-daemon/telegram-bot-token not found in Bitwarden"
CF_TUNNEL_TOKEN=$(bw get password "mkt-daemon/cf-tunnel-token" 2>/dev/null) \
  || die "mkt-daemon/cf-tunnel-token not found in Bitwarden"

# ntfy topic — generate once, save to Bitwarden; reuse on redeploy
NTFY_TOPIC=$(bw get password "mkt-daemon/ntfy-topic" 2>/dev/null || true)
if [[ -z "$NTFY_TOPIC" ]]; then
  NTFY_TOPIC="mkt-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:16])')"
  NTFY_TOPIC="$NTFY_TOPIC" bw get template item | NTFY_TOPIC="$NTFY_TOPIC" python3 -c "
import sys,json,os
t=json.load(sys.stdin)
t['name']='mkt-daemon/ntfy-topic'
t['collectionIds']=['0a1e6ed2-6366-41d6-b0be-b457016ecf0a']
t['login']={'password':'$NTFY_TOPIC'}
t['notes']='ntfy.sh topic for mkt alert notifications. Subscribe: https://ntfy.sh/$NTFY_TOPIC'
print(json.dumps(t))
" | bw encode | bw create item > /dev/null
  ok "ntfy topic generated and saved to Bitwarden: $NTFY_TOPIC"
else
  ok "ntfy topic loaded from Bitwarden: $NTFY_TOPIC"
fi

# Alert email recipient — OPTIONAL. When present, ntfy delivers each alert as an
# email too (native ntfy `Email:` header — no Resend/SMTP account). Add it with:
#   bw create ... name=mkt-daemon/alert-email  (or set in Bitwarden 'dev' collection)
ALERT_EMAIL=$(bw get password "mkt-daemon/alert-email" 2>/dev/null || true)
if [[ -n "$ALERT_EMAIL" ]]; then
  ok "alert email loaded from Bitwarden: $ALERT_EMAIL"
else
  echo "  ⚠ mkt-daemon/alert-email not set — email delivery stays off until you add it"
fi

# ntfy access token — REQUIRED for email delivery. ntfy.sh blocks anonymous email
# sending; the Email header needs a token from a (free) ntfy account. Push works
# without it. Create: register at ntfy.sh → Account → Access tokens → store as
# Bitwarden item 'mkt-daemon/ntfy-token'.
NTFY_TOKEN=$(bw get password "mkt-daemon/ntfy-token" 2>/dev/null || true)
if [[ -n "$NTFY_TOKEN" ]]; then
  ok "ntfy token loaded from Bitwarden (email delivery enabled)"
else
  echo "  ⚠ mkt-daemon/ntfy-token not set — ntfy blocks anonymous email; email stays off (push still works)"
fi

# API token — generate once, stored ONLY in ~/.config/mkt-watch/auth.json (user secret, not BW)
AUTH_JSON="$HOME/.config/mkt-watch/auth.json"
if [[ -f "$AUTH_JSON" ]]; then
  API_TOKEN=$(python3 -c "import json; print(json.load(open('$AUTH_JSON'))['token'])")
  ok "API token loaded from $AUTH_JSON"
else
  API_TOKEN=$(openssl rand -hex 32)
  ok "API token generated"
fi

ok "secrets loaded from Bitwarden"

# ── Phase 1: GCP VM ───────────────────────────────────────────────────────────
log "Phase 1: VM ($VM_NAME, $VM_TYPE, $GCP_ZONE)"

STATUS=$(G compute instances describe "$VM_NAME" \
  --zone="$GCP_ZONE" --project="$GCP_PROJECT" \
  --format="value(status)" 2>/dev/null || echo "ABSENT")

case "$STATUS" in
  RUNNING)   ok "VM running" ;;
  TERMINATED|STOPPED)
    G compute instances start "$VM_NAME" --zone="$GCP_ZONE" --project="$GCP_PROJECT"
    sleep 20; ok "VM started (was $STATUS)" ;;
  ABSENT)
    G compute instances create "$VM_NAME" \
      --project="$GCP_PROJECT" --zone="$GCP_ZONE" \
      --machine-type="$VM_TYPE" \
      --image-family=debian-12 --image-project=debian-cloud \
      --boot-disk-size=20GB --boot-disk-type=pd-standard
    sleep 30; ok "VM created" ;;
esac

# ── Phase 2: Cloudflare DNS ───────────────────────────────────────────────────
log "Phase 2: DNS ($TUNNEL_HOST)"

# Decode tunnel ID from token
TUNNEL_ID=$(echo "$CF_TUNNEL_TOKEN" | base64 -d 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['t'])")
ok "Tunnel ID: $TUNNEL_ID"

# Upsert CNAME
EXISTING=$(CF_API GET "/zones/$CF_ZONE_ID/dns_records?type=CNAME&name=$TUNNEL_HOST" \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')" 2>/dev/null || true)
DNS_BODY="{\"type\":\"CNAME\",\"name\":\"mkt\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true,\"ttl\":1}"
if [[ -z "$EXISTING" ]]; then
  CF_API POST "/zones/$CF_ZONE_ID/dns_records" -d "$DNS_BODY" > /dev/null
  ok "DNS created"
else
  CF_API PUT "/zones/$CF_ZONE_ID/dns_records/$EXISTING" -d "$DNS_BODY" > /dev/null
  ok "DNS updated"
fi

# ── Phase 3: Remote setup ─────────────────────────────────────────────────────
log "Phase 3: remote setup (Go, Bun, mkt, systemd)"

# Write tmp env file (never committed)
TMP_ENV=$(mktemp)
cat > "$TMP_ENV" <<EOF
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_CHAT_ID=@CryptoAiInvestor
NTFY_TOPIC=${NTFY_TOPIC}
NTFY_TOKEN=${NTFY_TOKEN}
ALERT_EMAIL=${ALERT_EMAIL}
API_TOKEN=${API_TOKEN}
MKT_ORIGIN=http://127.0.0.1:8080
PORT=9000
EOF

SCP "$TMP_ENV" "/tmp/mkt-daemon.env"
rm -f "$TMP_ENV"

# Upload api server + package.json (yaml dep)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
for f in api.ts dividend_watch.ts check.ts store.ts indicators.ts package.json; do
  [[ -f "$SCRIPT_DIR/scripts/$f" ]] && SCP "$SCRIPT_DIR/scripts/$f" "/tmp/$f"
done

SSH "$(cat << REMOTE
set -euo pipefail
export PATH=\$PATH:/usr/local/go/bin:\$HOME/.local/bin:\$HOME/.bun/bin

# ── apt deps ─────────────────────────────────────────────────────────────────
sudo apt-get install -y -qq unzip git curl 2>/dev/null

# ── Go ────────────────────────────────────────────────────────────────────────
if ! command -v go &>/dev/null; then
  curl -fsSL https://go.dev/dl/go1.22.4.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
  echo 'export PATH=\$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/go.sh > /dev/null
fi
export PATH=\$PATH:/usr/local/go/bin

# ── mkt binary ────────────────────────────────────────────────────────────────
mkdir -p \$HOME/.local/bin \$HOME/.local/src
if [[ ! -f \$HOME/.local/bin/mkt ]]; then
  git clone --quiet https://github.com/stxkxs/mkt \$HOME/.local/src/mkt
  cd \$HOME/.local/src/mkt && git checkout ${MKT_COMMIT} -q
  go build -o \$HOME/.local/bin/mkt .
fi
echo "  mkt: \$(\$HOME/.local/bin/mkt version)"

# ── Bun ───────────────────────────────────────────────────────────────────────
if [[ ! -f \$HOME/.bun/bin/bun ]]; then
  curl -fsSL https://bun.sh/install | bash -s -- --no-modify-path 2>/dev/null
fi
export PATH=\$PATH:\$HOME/.bun/bin
echo "  bun: \$(bun --version)"

# ── skill scripts + api server ────────────────────────────────────────────────
MKT_SCRIPTS=\$HOME/.agents/skills/mkt/scripts
mkdir -p "\$MKT_SCRIPTS"
for f in api.ts dividend_watch.ts check.ts store.ts indicators.ts; do
  [[ -f /tmp/\$f ]] && cp /tmp/\$f "\$MKT_SCRIPTS/"
done
if [[ -f /tmp/package.json ]]; then
  cp /tmp/package.json "\$MKT_SCRIPTS/"
  cd "\$MKT_SCRIPTS" && bun install --quiet
fi

# ── env / secrets ─────────────────────────────────────────────────────────────
sudo cp /tmp/mkt-daemon.env /etc/mkt-daemon.env
sudo chmod 600 /etc/mkt-daemon.env

# ── systemd: mkt-daemon ───────────────────────────────────────────────────────
U=\$(whoami)
sudo tee /etc/systemd/system/mkt-daemon.service > /dev/null << SVC
[Unit]
Description=mkt price daemon
After=network-online.target

[Service]
Type=simple
User=\$U
EnvironmentFile=/etc/mkt-daemon.env
Environment=HOME=/home/\$U
Environment=PATH=/usr/local/go/bin:/home/\$U/.local/bin:/home/\$U/.bun/bin:/usr/bin:/bin
ExecStart=/home/\$U/.local/bin/mkt daemon --listen ${MKT_LISTEN}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SVC

sudo systemctl daemon-reload
sudo systemctl enable --now mkt-daemon
sudo systemctl restart mkt-daemon
sleep 3
sudo systemctl is-active mkt-daemon && echo "  ✓ mkt-daemon active"

# ── systemd: mkt-api (Bun HTTP API on :9000) ─────────────────────────────────
sudo tee /etc/systemd/system/mkt-api.service > /dev/null << SVC
[Unit]
Description=mkt HTTP API
After=network-online.target mkt-daemon.service

[Service]
Type=simple
User=\$U
EnvironmentFile=/etc/mkt-daemon.env
Environment=HOME=/home/\$U
Environment=PATH=/usr/local/go/bin:/home/\$U/.local/bin:/home/\$U/.bun/bin:/usr/bin:/bin
WorkingDirectory=/home/\$U/.agents/skills/mkt/scripts
ExecStart=/home/\$U/.bun/bin/bun api.ts
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SVC

sudo systemctl daemon-reload
sudo systemctl enable --now mkt-api
sleep 2
sudo systemctl is-active mkt-api && echo "  ✓ mkt-api active"

# ── systemd: dividend-watch (daily payout monitor via timer) ─────────────────
# The mkt Go daemon only polls price/indicator conditions; it has no engine for
# arbitrary scheduled jobs. This timer IS that engine: it runs the headless
# dividend watcher daily (no Chrome), pushing to the same ntfy + Telegram channels
# from /etc/mkt-daemon.env. Persistent=true reruns a job missed while the box was off.
sudo tee /etc/systemd/system/dividend-watch.service > /dev/null << SVC
[Unit]
Description=dividend payout watcher (daily)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=\$U
EnvironmentFile=/etc/mkt-daemon.env
Environment=HOME=/home/\$U
Environment=PATH=/home/\$U/.bun/bin:/usr/bin:/bin
Environment=TICKERS=SITC
WorkingDirectory=/home/\$U/.agents/skills/mkt/scripts
ExecStart=/home/\$U/.bun/bin/bun dividend_watch.ts
SVC

sudo tee /etc/systemd/system/dividend-watch.timer > /dev/null << TMR
[Unit]
Description=run dividend-watch daily after US market close

[Timer]
OnCalendar=*-*-* 21:15:00
Persistent=true

[Install]
WantedBy=timers.target
TMR

sudo systemctl daemon-reload
sudo systemctl enable --now dividend-watch.timer
echo "  ✓ dividend-watch.timer enabled ($(systemctl is-enabled dividend-watch.timer 2>/dev/null))"

# ── systemd: mkt-check (general price/indicator alert checker via timer) ──────
# check.ts is the condition engine the mkt Go daemon isn't wired for here: it
# reads alert jobs from MKT_ALERTS_STORE, pulls live prices via 'mkt mcp', and
# notifies over each job's channel. The 'email:<addr>' channel publishes to the
# same ntfy topic with an 'Email:' header, so ntfy sends the alert as an email —
# no Resend/SMTP account. Runs every 15 min; no-ops when the store has no jobs.
MKT_STORE=\$HOME/.config/mkt-watch/agent-alerts.json
mkdir -p "\$(dirname \$MKT_STORE)"
sudo tee /etc/systemd/system/mkt-check.service > /dev/null << SVC
[Unit]
Description=mkt price/indicator alert checker
After=network-online.target mkt-daemon.service
Wants=network-online.target

[Service]
Type=oneshot
User=\$U
EnvironmentFile=/etc/mkt-daemon.env
Environment=HOME=/home/\$U
Environment=PATH=/home/\$U/.local/bin:/home/\$U/.bun/bin:/usr/bin:/bin
Environment=MKT_ALERTS_STORE=/home/\$U/.config/mkt-watch/agent-alerts.json
WorkingDirectory=/home/\$U/.agents/skills/mkt/scripts
ExecStart=/home/\$U/.bun/bin/bun check.ts
SVC

sudo tee /etc/systemd/system/mkt-check.timer > /dev/null << TMR
[Unit]
Description=run mkt-check every 15 minutes

[Timer]
OnCalendar=*:0/15
Persistent=true

[Install]
WantedBy=timers.target
TMR

sudo systemctl daemon-reload
sudo systemctl enable --now mkt-check.timer
echo "  ✓ mkt-check.timer enabled (\$(systemctl is-enabled mkt-check.timer 2>/dev/null))"

# ── cloudflared ───────────────────────────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main' \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list
  sudo apt-get update -qq && sudo apt-get install -y -qq cloudflared
fi

# Reinstall service with current token (idempotent)
sudo cloudflared service install ${CF_TUNNEL_TOKEN} 2>/dev/null || true

# Update ingress to point to mkt-api on :9000 (not mkt daemon :8080 directly)
sudo mkdir -p /etc/cloudflared
sudo tee /etc/cloudflared/config.yml > /dev/null << CFG
tunnel: $(echo "${CF_TUNNEL_TOKEN}" | base64 -d 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['t'])" 2>/dev/null || true)
ingress:
  - hostname: ${TUNNEL_HOST}
    service: http://127.0.0.1:${API_PORT}
  - service: http_status:404
CFG

sudo systemctl restart cloudflared
sleep 3
sudo systemctl is-active cloudflared && echo "  ✓ cloudflared active"
echo "=== done ==="
REMOTE
)"

ok "remote setup complete"

# ── Phase 4: Write local auth config ─────────────────────────────────────────
log "Phase 4: writing ~/.config/mkt-watch/auth.json"

mkdir -p "$HOME/.config/mkt-watch"
cat > "$HOME/.config/mkt-watch/auth.json" << JSON
{
  "apiUrl": "https://$TUNNEL_HOST",
  "token": "$API_TOKEN"
}
JSON
chmod 600 "$HOME/.config/mkt-watch/auth.json"
ok "auth written to ~/.config/mkt-watch/auth.json (600)"

# ── Phase 5: Verify ───────────────────────────────────────────────────────────
log "Phase 5: verify"
sleep 5
if curl -sf -H "Authorization: Bearer $API_TOKEN" "https://$TUNNEL_HOST/subscribe" | grep -q "ntfy"; then
  ok "https://$TUNNEL_HOST/subscribe — OK"
else
  echo "  ⚠ API not yet reachable — check: sudo journalctl -u mkt-api -n 20"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅  https://$TUNNEL_HOST"
echo ""
echo "  📲 Subscribe to alerts:"
echo "     bun mkt-alerts.ts subscribe"
echo ""
echo "  Add alert:"
echo "     bun mkt-alerts.ts add --symbol BTC-USD --condition below --value 90000 --reason 'support break'"
echo ""
echo "  SSH: gcloud --configuration=bisonte compute ssh $VM_NAME --zone=$GCP_ZONE --project=$GCP_PROJECT"
echo "═══════════════════════════════════════════════════════"
