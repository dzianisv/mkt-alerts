# Verification evidence — mkt-alerts OpenClaw plugin

All commands run from `integrations/openclaw/` on 2026-07-22.

## Environment

```
node v26.0.0
npm 11.12.1
tsc Version 5.7.3
openclaw installed (devDependency, for types): 2026.7.1-2   # the PUBLISHED npm package
```

Cross-checked against the local OpenClaw checkout at `/Users/engineer/workspace/openclaw` (v2026.4.16); the plugin-SDK API surface is identical.

---

## 1. Type-check against the REAL SDK — `npx tsc --noEmit`

`tsconfig.json` uses `"module"/"moduleResolution": "NodeNext"` (resolves the `openclaw/plugin-sdk/*` subpath exports) and `allowImportingTsExtensions` (for the `./indicators.ts` import). Clean pass — exit 0, no diagnostics:

```
$ npx tsc --noEmit ; echo "EXIT=$?"
EXIT=0
```

This also proves the compile-time assertion in `index.ts` `startService()`:

```ts
const wake: WakeRuntime = api; // OpenClawPluginApi must be assignable to our narrow WakeRuntime
```

i.e. our narrow `WakeRuntime` (the `enqueueSystemEvent` / `runHeartbeatOnce` signatures we mock) is a **faithful subset of the real `OpenClawPluginApi`/`PluginRuntime`** types. If the SDK signatures drifted, this line would fail `tsc`.

Runtime value-import of the SDK routing subpath also resolves (used for `sessionKey`):

```
$ node --input-type=module -e "import('openclaw/plugin-sdk/routing').then(m=>{console.log('buildAgentMainSessionKey=',typeof m.buildAgentMainSessionKey); console.log('key=', m.buildAgentMainSessionKey({agentId:'main'}));})"
buildAgentMainSessionKey= function
key= agent:main:main
```

---

## 2. Live data-fetch proof — `node --experimental-strip-types fetch-check.ts`

Exercises the plugin's real `fetchJobData` against public, key-free endpoints (Coinbase for crypto, Yahoo Finance for stocks). No API keys, no `mkt.agentlabs.cc`, no GCP.

```
$ node --experimental-strip-types fetch-check.ts ; echo "EXIT=$?"

[Coinbase BTC-USD]
  price      = 65817.595
  changePct  = -1.050%
  closes.len = 350
  closes.tail= [64681.78,65213.05,66516.18,65821.82]

[Yahoo AAPL]
  price      = 327.74
  changePct  = 0.352%
  closes.len = 62
  closes.tail= [333.260009765625,333.739990234375,326.5899963378906,327.739990234375]

LIVE-FETCH PASS: both public sources returned a finite price and >=35 daily closes.
EXIT=0
```

Raw endpoint shapes confirmed by direct `curl` during implementation:

```
$ curl -s "https://api.coinbase.com/v2/prices/BTC-USD/spot"
{"data":{"amount":"65813.755","base":"BTC","currency":"USD"}}

# Coinbase daily candles (newest-first: [time, low, high, open, close, volume]) — 350 rows
$ curl -s "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400"
newest row = [1784678400,65653.46,66698.55,66516.17,65823.98,2163.43611466]

# Yahoo chart: meta.regularMarketPrice + indicators.quote[0].close[]
$ curl -s "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1mo"
meta.regularMarketPrice= 327.74 ; close.len= 21   # (plugin uses range=3mo → 62 closes, enough for MACD's 35)
```

---

## 3. Plugin-load + wake harness — `node --experimental-strip-types verify-harness.ts`

Imports the **real** `index.ts` (default export + `runCheckTick`), builds a real-shaped mock `api`/`wake` (function bodies are spies; signatures typed via `WakeRuntime`/`OpenClawPluginApi`), and asserts the full path. Deterministic and offline (injected `fetchData`), state written to `integrations/openclaw/.verify-state/` (never `/tmp`).

```
$ node --experimental-strip-types verify-harness.ts ; echo "EXIT=$?"
PASS  buildAgentMainSessionKey returns non-empty key — agent:main:main
PASS  session key shape agent:main:main — agent:main:main
PASS  register() captured a service
PASS  service id is mkt-alerts-checker
PASS  service start()/stop() ran without throwing (offline)
PASS  tick reports the alert fired — {"evaluated":1,"fired":["btc-above-1000"]}
PASS  enqueueSystemEvent called exactly once — count=1
PASS  enqueueSystemEvent text mentions the symbol — 🔔 mkt alert — BTC-USD fired @ 65000 (2026-07-22T12:00:00.000Z)
PASS  enqueueSystemEvent got a non-empty sessionKey — agent:main:main
PASS  enqueueSystemEvent sessionKey matches resolved key
PASS  runHeartbeatOnce called exactly once — count=1
PASS  runHeartbeatOnce used heartbeat.target=last — last
PASS  runHeartbeatOnce carried the resolved sessionKey
PASS  non-firing alert reports zero fires
PASS  non-firing alert did not enqueue
PASS  non-firing alert did not heartbeat
PASS  one-shot alert is not re-evaluated after firing — evaluated=0
PASS  one-shot alert does not wake again

HARNESS PASS
EXIT=0
```

### 3b. End-to-end tick against LIVE data (fetch → evaluate → wake)

A guaranteed-fire alert (`BTC-USD above $1`) driven through `runCheckTick` with the **real** live fetcher and a spy wake:

```
$ node --experimental-strip-types --input-type=module -e '<inline runCheckTick with live fetchData>'
info mkt-alerts: live-btc FIRED — above:1=✓(price=65809.085)
RESULT {"evaluated":1,"fired":["live-btc"]}
ENQUEUED_TEXT:
🔔 mkt alert — BTC-USD fired @ 65809.085 (2026-07-22T12:34:11.906Z)
Conditions: above @ 1
WHY: e2e live: BTC is above $1
[above:1=✓(price=65809.085)]
HEARTBEAT: {"agentId":"main","sessionKey":"agent:main:main","reason":"mkt-alert:live-btc","heartbeat":{"target":"last"}}
LIVE-E2E PASS
EXIT=0
```

---

## SDK export names used (verified against `/Users/engineer/workspace/openclaw`)

| Symbol | Import subpath | Source (local checkout) |
|---|---|---|
| `definePluginEntry` | `openclaw/plugin-sdk/plugin-entry` | `src/plugin-sdk/plugin-entry.ts:181` (requires `id`,`name`,`description`,`register`) |
| `buildAgentMainSessionKey` | `openclaw/plugin-sdk/routing` | re-export in `src/plugin-sdk/routing.ts:11`; def `src/routing/session-key.ts:120` |
| `OpenClawPluginApi` (type) | `openclaw/plugin-sdk/plugin-entry` | `src/plugins/types.ts:1867` (`.pluginConfig`, `.runtime`, `.logger`, `.registerService`) |
| `OpenClawPluginServiceContext` (type) | `openclaw/plugin-sdk/plugin-entry` | `src/plugins/types.ts:1812` (`.config`,`.stateDir`,`.logger`) |
| `PluginLogger` (type) | `openclaw/plugin-sdk/plugin-entry` | `src/plugins/types.ts:159` |
| `api.registerService(service)` | — | `src/plugins/types.ts:1927`; service `src/plugins/types.ts:1820` |
| `api.runtime.system.enqueueSystemEvent(text,{sessionKey,trusted})` | — | `src/infra/system-events.ts:90` (sync `boolean`; throws w/o sessionKey at `:46`) |
| `api.runtime.system.runHeartbeatOnce({agentId,sessionKey,heartbeat:{target}})` | — | type `src/plugins/runtime/types-core.ts:83` (+ `RunHeartbeatOnceOptions` `:31`) |
| manifest validation source | — | loader uses the static `openclaw.plugin.json` `configSchema`: `src/plugins/loader.ts:1848,1878` |

## Deltas found vs the design doc / research (details in the PR body)

1. `DEFAULT_AGENT_ID` is **not** re-exported from `plugin-sdk/routing` (only `DEFAULT_MAIN_KEY` is — `src/plugin-sdk/routing.ts:10-25`). Used the verified literal `"main"` instead.
2. Plugin `config` is validated by the **manifest** JSON-Schema (`openclaw.plugin.json`), not the runtime `definePluginEntry.configSchema` (`loader.ts:1848,1878`). The default runtime schema (`emptyPluginConfigSchema`) actively *rejects* non-empty config, so a runtime schema was deliberately omitted (matches the shipping `device-pair` plugin).
3. `enqueueSystemEvent` requires a non-empty `sessionKey` (throws otherwise); it is synchronous and returns `boolean`; and alone it does **not** wake the agent — `runHeartbeatOnce({heartbeat:{target:"last"}})` is what forces the turn.
