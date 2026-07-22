/**
 * Verification harness for the mkt-alerts OpenClaw plugin.
 *
 * Proves, without a live gateway:
 *   1. The real plugin entry registers a service (register → registerService).
 *   2. The service start()/stop() wire a poller cleanly (offline, no alerts).
 *   3. A firing alert calls enqueueSystemEvent(text, {sessionKey}) AND
 *      runHeartbeatOnce(...) — the actual wake path — with a deterministic,
 *      injected data fetcher (no network, no price flakiness).
 *   4. A non-firing alert wakes nothing.
 *   5. A one-shot alert does not re-fire on the next tick (fire-state persists).
 *
 * The mocked `api`/`wake` keep the REAL SDK signatures (WakeRuntime is a
 * compile-checked subset of OpenClawPluginApi); only the function bodies are
 * spies. Run: node --experimental-strip-types verify-harness.ts
 */
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildAgentMainSessionKey } from "openclaw/plugin-sdk/routing";
import type { OpenClawPluginApi, OpenClawPluginService, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import plugin, {
  runCheckTick,
  type AlertJob,
  type JobData,
  type WakeRuntime,
  type PluginConfig,
} from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const silentLogger: PluginLogger = {
  debug: () => {},
  info: () => {},
  warn: (m) => console.log(`    [warn] ${m}`),
  error: (m) => console.log(`    [error] ${m}`),
};

type WakeCall = { text: string; sessionKey: string };
function makeWake() {
  const enqueued: WakeCall[] = [];
  const heartbeats: Array<{ sessionKey?: string; target?: string; reason?: string }> = [];
  const wake: WakeRuntime = {
    logger: silentLogger,
    runtime: {
      system: {
        enqueueSystemEvent: (text, options) => {
          enqueued.push({ text, sessionKey: options.sessionKey });
          return true;
        },
        runHeartbeatOnce: async (opts) => {
          heartbeats.push({
            sessionKey: opts?.sessionKey,
            target: opts?.heartbeat?.target,
            reason: opts?.reason,
          });
          return { ran: true };
        },
      },
    },
  };
  return { wake, enqueued, heartbeats };
}

/** Deterministic ~60-bar close series so RSI/SMA/MACD never throw. */
function syntheticCloses(): number[] {
  return Array.from({ length: 60 }, (_, i) => 60000 + Math.sin(i / 3) * 500 + i * 10);
}

async function main() {
  const sessionKey = buildAgentMainSessionKey({ agentId: "main" });
  check("buildAgentMainSessionKey returns non-empty key", sessionKey.length > 0, sessionKey);
  check("session key shape agent:main:main", sessionKey === "agent:main:main", sessionKey);

  // ── 1 + 2: register + start/stop wiring, fully offline (no alerts) ─────────
  let captured: OpenClawPluginService | null = null;
  const startState = join(here, ".verify-state", "wiring");
  if (existsSync(startState)) rmSync(startState, { recursive: true, force: true });
  const wiringApi = {
    id: "mkt-alerts",
    name: "Market Alerts",
    source: "test",
    registrationMode: "full",
    config: {},
    pluginConfig: { intervalSec: 10, alerts: [] } as PluginConfig,
    logger: silentLogger,
    runtime: { system: makeWake().wake.runtime.system },
    registerService: (svc: OpenClawPluginService) => {
      captured = svc;
    },
  } as unknown as OpenClawPluginApi;

  plugin.register(wiringApi);
  check("register() captured a service", captured !== null);
  check("service id is mkt-alerts-checker", (captured as OpenClawPluginService | null)?.id === "mkt-alerts-checker");

  const svc = captured as unknown as OpenClawPluginService;
  let startThrew = false;
  try {
    await svc.start({ config: {} as never, stateDir: startState, logger: silentLogger });
    svc.stop?.({ config: {} as never, stateDir: startState, logger: silentLogger });
  } catch (e) {
    startThrew = true;
    console.log(`    start/stop threw: ${e}`);
  }
  check("service start()/stop() ran without throwing (offline)", !startThrew);

  // ── 3: firing alert triggers the real wake path (deterministic) ────────────
  const fireState = join(here, ".verify-state", "fire");
  if (existsSync(fireState)) rmSync(fireState, { recursive: true, force: true });

  const firingJob: AlertJob = {
    id: "btc-above-1000",
    desk: "crypto",
    symbol: "BTC-USD",
    conditions: [{ condition: "above", value: 1000 }],
    reasoning: "guaranteed fire: price far above threshold",
  };
  const controlledData: JobData = { price: 65000, changePct: 1.0, closes: syntheticCloses() };

  const w1 = makeWake();
  const res1 = await runCheckTick({
    config: { alerts: [firingJob] },
    stateDir: fireState,
    logger: silentLogger,
    wake: w1.wake,
    sessionKey,
    agentId: "main",
    fetchData: async () => controlledData,
    now: () => new Date("2026-07-22T12:00:00Z"),
  });

  check("tick reports the alert fired", res1.fired.includes("btc-above-1000"), JSON.stringify(res1));
  check("enqueueSystemEvent called exactly once", w1.enqueued.length === 1, `count=${w1.enqueued.length}`);
  check(
    "enqueueSystemEvent text mentions the symbol",
    w1.enqueued[0]?.text.includes("BTC-USD") ?? false,
    w1.enqueued[0]?.text.split("\n")[0],
  );
  check(
    "enqueueSystemEvent got a non-empty sessionKey",
    (w1.enqueued[0]?.sessionKey?.length ?? 0) > 0,
    w1.enqueued[0]?.sessionKey,
  );
  check("enqueueSystemEvent sessionKey matches resolved key", w1.enqueued[0]?.sessionKey === sessionKey);
  check("runHeartbeatOnce called exactly once", w1.heartbeats.length === 1, `count=${w1.heartbeats.length}`);
  check("runHeartbeatOnce used heartbeat.target=last", w1.heartbeats[0]?.target === "last", w1.heartbeats[0]?.target);
  check("runHeartbeatOnce carried the resolved sessionKey", w1.heartbeats[0]?.sessionKey === sessionKey);

  // ── 4: non-firing alert wakes nothing ──────────────────────────────────────
  const noFireState = join(here, ".verify-state", "nofire");
  if (existsSync(noFireState)) rmSync(noFireState, { recursive: true, force: true });
  const w2 = makeWake();
  const res2 = await runCheckTick({
    config: {
      alerts: [
        {
          id: "btc-above-huge",
          desk: "crypto",
          symbol: "BTC-USD",
          conditions: [{ condition: "above", value: 999_999_999 }],
          reasoning: "never fires",
        },
      ],
    },
    stateDir: noFireState,
    logger: silentLogger,
    wake: w2.wake,
    sessionKey,
    agentId: "main",
    fetchData: async () => controlledData,
    now: () => new Date("2026-07-22T12:00:00Z"),
  });
  check("non-firing alert reports zero fires", res2.fired.length === 0);
  check("non-firing alert did not enqueue", w2.enqueued.length === 0);
  check("non-firing alert did not heartbeat", w2.heartbeats.length === 0);

  // ── 5: one-shot alert does not re-fire on the next tick (state persisted) ──
  const w3 = makeWake();
  const res3 = await runCheckTick({
    config: { alerts: [firingJob] },
    stateDir: fireState, // reuse the state dir from step 3 — job already marked fired
    logger: silentLogger,
    wake: w3.wake,
    sessionKey,
    agentId: "main",
    fetchData: async () => controlledData,
    now: () => new Date("2026-07-22T12:05:00Z"),
  });
  check("one-shot alert is not re-evaluated after firing", res3.evaluated === 0, `evaluated=${res3.evaluated}`);
  check("one-shot alert does not wake again", w3.enqueued.length === 0 && w3.heartbeats.length === 0);

  console.log(`\n${failures === 0 ? "HARNESS PASS" : `HARNESS FAIL (${failures} failing checks)`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
