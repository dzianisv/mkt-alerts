# Agent-Wake Plugin — mkt-alerts → OpenClaw / Hermes

Design for the next feature: **an alert fire wakes the AI agent chat so the agent acts on the condition automatically.**

Hard constraint: **no dependency on the GCP mkt-alerts instance.** The checker runs co-located on the agent host (OpenClaw), or, where co-location is impossible (Hermes is hosted), as a self-scheduled cron prompt. Prices come from a public data source or a local `mkt` binary — never `mkt.agentlabs.cc`.

## Two targets, two shapes

| Target | Nature | Plugin shape | Wake mechanism | New code |
|---|---|---|---|---|
| **OpenClaw** | Self-hosted, in-process | Native plugin running the checker as a service | `runtime.system.enqueueSystemEvent()` (in-process, no auth) | Repackage the MIT checker as ~1 file + manifest |
| **Hermes** | Hosted (Nous @AlfredAiBot) | A cron job / Skill whose prompt does the work | Cron agent turn → `deliver: telegram` | Zero (prompt only); reimplement threshold/RSI/pine logic in the prompt |

## OpenClaw — co-located daemon plugin (recommended MVP)

```
OpenClaw gateway process  (already runs as a persistent daemon)
 └─ plugin "mkt-alerts"
     ├─ api.registerService({ start }):  setInterval(tick, 60_000)     ← its own cadence
     │      tick():  fetch OHLCV from a PUBLIC api  →  evaluate store jobs
     │               (reuse the MIT scripts/check.ts + store.ts,
     │                optional pine-runner as a local subprocess)
     └─ on fire:  api.runtime.system.enqueueSystemEvent("🔔 BTC-USD below 90000 …", {})
                  api.runtime.system.requestHeartbeatNow()             ← optional nudge
```

- **Wake primitive:** `api.runtime.system.enqueueSystemEvent(text, { sessionKey })` injects a system event into the agent's main session, so it takes a turn and responds on the last channel. In-process function call — no network, no token. It is the same primitive behind the external `POST /hooks/wake` and the gateway `system-event` RPC. (`openclaw/docs/plugins/sdk-runtime.md:272-281`; `src/plugins/runtime/runtime-system.ts`; `src/gateway/server-methods/system.ts:54-145`.)
- **Alternatives:** `requestHeartbeatNow()` to piggyback the built-in heartbeat loop (default 30 min); `runtime.agent.runEmbeddedAgent({ prompt, sessionId })` to run a full turn from plugin code; `api.registerTool(...)` so the agent can CRUD its own alerts. (`sdk-runtime.md:53-67,278`.)
- **Own timer, no extra unit:** `registerService.start()` is for long-lived plugin services, so a `setInterval` there gives the checker its own cadence inside the always-on gateway — no separate systemd/pm2 needed, *provided the gateway itself is installed as a daemon* (`openclaw gateway install`). (`src/plugins/types.ts:1811-1824`.)
- **Packaging (easy-install):** a package with `openclaw.plugin.json` (`{id,name,description,configSchema}`), `package.json` (`"openclaw":{"extensions":["./index.ts"]}`), and `index.ts` exporting `definePluginEntry({ id, register(api){…} })`. Install with `openclaw plugins install ./mkt-alerts-plugin && openclaw gateway restart`, or drop-in via `plugins.load.paths: ["/opt/mkt-alerts-plugin"]`. (`openclaw/docs/plugins/building-plugins.md:55-117`; `docs/tools/plugin.md:156-177`.)
- **Zero GCP:** OHLCV via a plain `fetch()` to a public source (arbitrary Node runs in-process); `pine` conditions run the existing `pine-runner` as a local subprocess on the OpenClaw host.

Minimal entry (synthesized from the cited APIs):
```typescript
// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { checkAllJobs } from "./check.js";   // = scripts/check.ts logic, public-data fetch
import { loadStore } from "./store.js";

export default definePluginEntry({
  id: "mkt-alerts",
  name: "Market Alerts",
  register(api) {
    const runtime = api.runtime;
    let timer: ReturnType<typeof setInterval> | undefined;
    api.registerService({
      id: "mkt-alerts-checker",
      start: (ctx) => {
        const tick = async () => {
          for (const fired of await checkAllJobs(loadStore(ctx.stateDir))) {
            await runtime.system.enqueueSystemEvent(
              `🔔 mkt alert — ${fired.symbol} ${fired.condition}@${fired.value} fired @ ${fired.price}. ${fired.reasoning}`,
              {},
            );
            runtime.system.requestHeartbeatNow();
          }
        };
        timer = setInterval(tick, 60_000);
      },
      stop: () => { if (timer) clearInterval(timer); },
    });
  },
});
```

## Hermes — cron-prompt "plugin" (hosted, can't co-locate)

Co-location is impossible: @AlfredAiBot is a hosted Nous service, so there's nowhere to drop a daemon. The self-contained equivalent is a **cron job whose prompt does the work**. Cron runs in a fresh agent session with the normal tool list (web/browser, `execute_code`), so it can fetch public market data (outbound HTTP) and deliver back to the same chat/topic.

```
/cron add "*/5 * * * *" "Fetch the current price of BTC-USD and ETH-USD from a public
market data API. If BTC-USD < 90000 or ETH-USD RSI(14) < 30, send a concise alert with
symbol, level, and a one-line rationale. Otherwise reply HERMES_OK and send nothing.
Deliver to telegram."
```

- **Outbound + delivery verified:** the Daily-Briefing-Bot guide shows cron → fresh session → web search (outbound) → summarize → deliver, "no code required". Delivery targets include `telegram`, `telegram:<chat>`, `telegram:<chat>:<thread>` (topic). (`hermes-agent.nousresearch.com/docs/user-guide/features/cron`; `/docs/guides/daily-briefing-bot`.)
- **Reusable logic:** package the watchlist/threshold logic as a **Skill** and attach with `--skill`.
- **Limits:** can't embed `pine-runner`/`check.ts` inside hosted Hermes — reimplement threshold/RSI/pine logic in the prompt or Skill. Cron latency ≥ ~1 min (60 s scheduler tick). If you ever self-host your own Hermes gateway, its webhook adapter (`POST :8644/webhooks/<route>`, HMAC) lets a co-located checker push instead — but that's outside the hosted-@AlfredAiBot constraint.

## Rollout

1. **MVP1 — OpenClaw plugin.** Repackage the MIT checker as one plugin (index + manifest); wake via `enqueueSystemEvent`. Fully self-contained, reuses existing code including `pine`. Highest leverage.
2. **MVP2 — Hermes cron template + optional Skill.** Zero code; ship a documented `/cron` prompt.
3. **Shared core.** Factor a tiny `mkt-core` (evaluate + fetch OHLCV, no GCP) that the OpenClaw plugin imports and a future self-hosted-Hermes webhook could reuse.

## Open decisions

- Which public OHLCV source (or run the local `mkt` binary on the OpenClaw host).
- Where alerts live on the OpenClaw host (plugin `stateDir`).
- Whether to also `registerTool` so the agent CRUDs its own alerts vs. a static store file.
- Confirm the OpenClaw box runs the gateway as a persistent daemon (required for the service timer).
