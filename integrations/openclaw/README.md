# mkt-alerts — OpenClaw agent-wake plugin

**Your AI agent wakes up when the market hits your level.**

An in-process [OpenClaw](https://github.com/openclaw/openclaw) plugin that runs the
MIT-licensed mkt-alerts checker as a background service. On a fixed cadence it
fetches live prices from **public, key-free** endpoints, evaluates your alert
conditions (threshold / %-change / RSI / SMA-cross / MACD-cross), and when one
fires it **wakes the agent** — it seeds a system event onto the agent's session
and forces a heartbeat turn so the agent acts on the condition immediately,
on the last active channel.

- **No GCP, no `mkt.agentlabs.cc`.** Crypto prices come from Coinbase's public
  API; stock prices from Yahoo Finance's public chart API. No API keys.
- **No extra process.** The checker runs inside the always-on OpenClaw gateway
  via `registerService` + `setInterval` — no separate systemd/pm2 unit.
- **Zero runtime dependencies.** Only Node built-ins (`fetch`, `fs`, `path`).
  `openclaw` is a devDependency for types only.

## Install

```bash
# From this repo:
openclaw plugins install ./integrations/openclaw
openclaw gateway restart
```

Or drop-in via your OpenClaw config (`plugins.load.paths`), pointing at the
**absolute** path:

```jsonc
{
  "plugins": {
    "load": { "paths": ["/abs/path/to/mkt-alerts/integrations/openclaw"] },
    "entries": {
      "mkt-alerts": {
        "config": {
          "intervalSec": 60,
          "agentId": "main",
          "alerts": [
            {
              "desk": "crypto",
              "symbol": "BTC-USD",
              "conditions": [{ "condition": "below", "value": 90000 }],
              "reasoning": "Re-enter the swing long if BTC dips to the 90k demand zone.",
              "cooldownSec": 3600
            },
            {
              "desk": "stocks",
              "symbol": "AAPL",
              "match": "all",
              "conditions": [
                { "condition": "rsi_below", "value": 30, "period": 14 },
                { "condition": "pct_down", "value": 2 }
              ],
              "reasoning": "Oversold + down 2% intraday — check for a mean-reversion entry."
            }
          ]
        }
      }
    }
  }
}
```

## Configuration

| Field         | Type                              | Default | Notes                                                             |
|---------------|-----------------------------------|---------|-------------------------------------------------------------------|
| `intervalSec` | number (min 10)                   | `60`    | Poll cadence in seconds.                                          |
| `agentId`     | string                            | `main`  | Which agent to wake. Resolves `agent:<id>:main` as the sessionKey.|
| `dataSource`  | `auto` \| `coinbase` \| `yahoo`   | `auto`  | `auto` routes by `desk`: crypto→Coinbase, stocks→Yahoo.           |
| `alertsFile`  | string (absolute path)            | —       | Optional JSON file with an `AlertJob[]`, merged with `alerts`.    |
| `alerts`      | `AlertJob[]`                      | `[]`    | Inline alert definitions (see below).                             |

### Alert shape

```ts
type Cond = {
  condition: "above" | "below" | "pct_up" | "pct_down"
    | "rsi_above" | "rsi_below" | "sma_cross_above" | "sma_cross_below"
    | "macd_cross" | "volume_above" | "stddev_above" | "pine";
  value: number;
  period?: number;          // RSI/SMA period (default 14 / 20)
};

type AlertJob = {
  id?: string;              // derived from symbol+conditions if omitted (stable across restarts)
  desk: "crypto" | "stocks";
  symbol: string;           // "BTC-USD" (crypto) or "AAPL" (stock)
  match?: "all" | "any" | "sequence";   // default "all"
  conditions: Cond[];
  reasoning: string;        // shown to the agent so it knows WHY it woke
  cooldownSec?: number;     // re-arm after N seconds; omit for one-shot
  expiry?: string;          // ISO timestamp; alert stops evaluating after this
  analysisLink?: string;
};
```

Fire-state (which one-shot alerts have fired, cooldown timestamps) is persisted
in the plugin's `stateDir` as `fire-state.json` — never in this repo.

## How the wake works

1. `enqueueSystemEvent(text, { sessionKey, trusted: true })` seeds the alert text
   onto the agent's session queue. **This alone does not make the agent take a
   turn** — it only queues text for the next prompt.
2. `runHeartbeatOnce({ agentId, sessionKey, heartbeat: { target: "last" } })`
   forces a heartbeat turn **now** and delivers to the last active channel. This
   is the same pattern the production OpenClaw cron service uses to avoid the
   default `target: "none"` suppression.

A headless service has no inbound route, so the `sessionKey` is resolved with
`buildAgentMainSessionKey({ agentId })` from `openclaw/plugin-sdk/routing` — the
publicly-supported way to compute `agent:<id>:main`.

## Deferred (TODO)

- **Pine Script conditions** (`condition: "pine"`). Accepted for config parity
  but never fire in this MVP. Real support needs the isolated AGPL `pine-runner`
  spawned as a subprocess (kept out-of-process so the MIT plugin never imports
  AGPL). Configuring a pine condition logs a warning.
- **`match: "sequence"`** is currently evaluated identically to `"all"`. Proper
  ordering needs cross-run state (matches mkt-alerts upstream).
- **`volume_above` / `stddev_above`** always evaluate `false` (volume not in the
  current public-data path — same as mkt-alerts upstream).
- **`alertsFile` write-back / locking.** The file is read-only here; the atomic
  cross-process lock from `scripts/store.ts` is not ported (single-service owner).

## Verification

See [`EVIDENCE.md`](./EVIDENCE.md) for full logs. Reproduce with:

```bash
cd integrations/openclaw
npm install
npm run typecheck     # tsc --noEmit against the real openclaw SDK types
npm run verify:fetch  # live Coinbase + Yahoo fetch proof
npm run verify        # offline deterministic register/start/wake harness
```
