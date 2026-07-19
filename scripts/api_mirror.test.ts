#!/usr/bin/env bun
// Integration-style test: an alert created through the public API (POST /alerts)
// must be mirrored into the checker store (MKT_ALERTS_STORE) in the exact shape
// check.ts consumes, and must actually flow through checker dispatch. DELETE must
// remove the mirror too. All paths are temp; no production files are touched and
// no real network call is made (transport fetch is mocked).
//
// Env MUST be set before api.ts / store.ts are imported (they resolve paths at
// module load), so those modules are pulled in via top-level dynamic import after
// the env is populated below.

import { test, expect, describe, afterAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";

const DIR = join(import.meta.dir, "..", ".cache", `test-api-mirror-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
mkdirSync(DIR, { recursive: true });

const STORE_PATH = join(DIR, "agent-alerts.json");
const META_PATH = join(DIR, "alerts-meta.json");
const MKT_CONFIG = join(DIR, "config.yaml");

process.env.MKT_ALERTS_STORE = STORE_PATH;
process.env.META_PATH = META_PATH;
process.env.MKT_CONFIG = MKT_CONFIG;
process.env.MKT_HISTORY = join(DIR, "alert-history.ndjson");
process.env.API_TOKEN = "test-token";
process.env.NTFY_TOPIC = "mkt-testglobal"; // the daemon's global push topic

// Seed a minimal mkt config so loadMktConfig()/saveMktConfig() work.
writeFileSync(MKT_CONFIG, "watchlist: []\nportfolios: []\nalerts: []\npoll_interval: 15m\n");

const { handleRequest } = await import("./api.ts");
const { loadJobs, resolveChannelSpec } = await import("./store.ts");
const { evaluateJob, buildAlertMessage, notify } = await import("./check.ts");

afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://api.local${path}`, {
    method,
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function loadMeta(): any[] {
  return existsSync(META_PATH) ? JSON.parse(readFileSync(META_PATH, "utf8")) : [];
}

describe("API alert → checker store mirror → dispatch → delete", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.BREVO_API_KEY;
    delete process.env.ALERT_EMAIL_FROM;
  });

  test("email alert created via the public API (CLI `reasoning` shape) mirrors into the checker store", async () => {
    // The CLI sends `reasoning` (not `reason`) — prove that shape is accepted and
    // the alert lands in the store check.ts reads.
    const res = await handleRequest(req("POST", "/alerts", {
      symbol: "BTC-USD",
      reasoning: "Support break — invalidates bull thesis",
      desk: "crypto",
      conditions: [{ condition: "below", value: 90000 }],
      channels: ["email:you@example.com"],
      analysisLink: "https://notion.so/x",
    }));
    expect(res.status).toBe(201);
    const created = await res.json() as any;
    expect(created.id).toBeTruthy();

    const jobs = loadJobs();
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    // Same id as the meta entry → DELETE can remove both.
    expect(job.id).toBe(created.id);
    // Shape check.ts consumes:
    expect(job.symbol).toBe("BTC-USD");
    expect(job.reasoning).toBe("Support break — invalidates bull thesis");
    expect(job.conditions).toEqual([{ condition: "below", value: 90000 }]);
    expect(job.analysisLink).toBe("https://notion.so/x");
    expect(resolveChannelSpec(job)).toBe("email:you@example.com");
    // One-shot semantics preserved: not yet fired, no cooldown.
    expect(job.fired).toBeFalsy();
    expect(job.cooldownSec).toBeUndefined();

    // meta + config compatibility preserved.
    const meta = loadMeta();
    expect(meta.find(m => m.id === created.id)?.reason).toBe("Support break — invalidates bull thesis");
    const cfg = readFileSync(MKT_CONFIG, "utf8");
    expect(cfg).toContain("BTC-USD");
  });

  test("the mirrored job flows through checker evaluation + dispatch (Brevo email)", async () => {
    const job = loadJobs().find(j => j.symbol === "BTC-USD")!;
    // Evaluate exactly as check.ts main() would.
    const { fires } = evaluateJob(job, { price: 88000 });
    expect(fires).toBe(true);

    const calls: any[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: init?.body });
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    process.env.BREVO_API_KEY = "xkeysib_test_key";
    process.env.ALERT_EMAIL_FROM = "vibeteaichnologies@gmail.com";

    const msg = buildAlertMessage(job, 88000, "2026-07-18T12:34:56.000Z");
    await notify(resolveChannelSpec(job), msg);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.brevo.com/v3/smtp/email");
    const payload = JSON.parse(calls[0].body);
    expect(payload.to).toEqual([{ email: "you@example.com" }]);
    expect(payload.sender).toEqual({ email: "vibeteaichnologies@gmail.com" });
    expect(payload.textContent).toContain("Support break");
  });

  test("cooldownSec passed via API is preserved in the mirror (fired/cooldown semantics)", async () => {
    const res = await handleRequest(req("POST", "/alerts", {
      symbol: "ETH-USD",
      reasoning: "recurring level watch",
      conditions: [{ condition: "above", value: 5000 }],
      channels: ["email:you@example.com"],
      cooldownSec: 3600,
    }));
    expect(res.status).toBe(201);
    const created = await res.json() as any;
    const job = loadJobs().find(j => j.id === created.id)!;
    expect(job.cooldownSec).toBe(3600);
  });

  test("compatibility boundary: default push (no channels) is NOT mirrored — the daemon owns it", async () => {
    const before = loadJobs().length;
    const res = await handleRequest(req("POST", "/alerts", {
      symbol: "SOL-USD",
      reasoning: "phone push only",
      conditions: [{ condition: "below", value: 100 }],
    }));
    expect(res.status).toBe(201);
    expect(loadJobs().length).toBe(before); // nothing added to the checker store
  });

  test("compatibility boundary: an explicit ntfy:<global topic> is NOT mirrored (no double push)", async () => {
    const before = loadJobs().length;
    const res = await handleRequest(req("POST", "/alerts", {
      symbol: "XRP-USD",
      reasoning: "global topic push",
      conditions: [{ condition: "below", value: 1 }],
      channels: ["ntfy:mkt-testglobal"],
    }));
    expect(res.status).toBe(201);
    expect(loadJobs().length).toBe(before);
  });

  test("DELETE removes both the meta entry and the mirrored checker job", async () => {
    const target = loadJobs().find(j => j.symbol === "BTC-USD")!;
    const res = await handleRequest(req("DELETE", `/alerts/${target.id}`));
    expect(res.status).toBe(200);
    const out = await res.json() as any;
    expect(out.removed).toBe(target.id);

    // mirror gone from the checker store
    expect(loadJobs().find(j => j.id === target.id)).toBeUndefined();
    // meta gone too
    expect(loadMeta().find(m => m.id === target.id)).toBeUndefined();
  });
});
