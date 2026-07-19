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

// The mkt daemon config is YAML; we only need to know whether a given symbol was
// projected as a rule, so a substring check on the raw file is enough and avoids a
// YAML dep in the test.
function configHasSymbol(symbol: string): boolean {
  return existsSync(MKT_CONFIG) && readFileSync(MKT_CONFIG, "utf8").includes(symbol);
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

    // meta stays (for GET/list + DELETE); config does NOT — an email-only alert
    // must not be projected to the daemon or it would fire a duplicate global push.
    const meta = loadMeta();
    expect(meta.find(m => m.id === created.id)?.reason).toBe("Support break — invalidates bull thesis");
    expect(configHasSymbol("BTC-USD")).toBe(false);
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

describe("channel projection semantics — daemon config vs checker store", () => {
  test("email-only alert → checker store + meta, but NOT the daemon config", async () => {
    const res = await handleRequest(req("POST", "/alerts", {
      symbol: "LINK-USD",
      reasoning: "email-only, no phone push",
      conditions: [{ condition: "below", value: 10 }],
      channels: ["email:you@example.com"],
    }));
    expect(res.status).toBe(201);
    const created = await res.json() as any;

    // Mirrored into the checker store (it owns email delivery)…
    expect(loadJobs().find(j => j.id === created.id && j.symbol === "LINK-USD")).toBeTruthy();
    // …present in meta (so GET/list + DELETE work)…
    expect(loadMeta().find(m => m.id === created.id)).toBeTruthy();
    // …but NOT projected to the daemon config (would cause a duplicate global push).
    expect(configHasSymbol("LINK-USD")).toBe(false);
  });

  test("non-global ntfy:<topic>-only alert → checker + meta, NOT config", async () => {
    const res = await handleRequest(req("POST", "/alerts", {
      symbol: "ADA-USD",
      reasoning: "route to a private topic, not the global daemon topic",
      conditions: [{ condition: "above", value: 2 }],
      channels: ["ntfy:my-private-topic"],
    }));
    expect(res.status).toBe(201);
    const created = await res.json() as any;
    expect(loadJobs().find(j => j.id === created.id)).toBeTruthy();
    expect(configHasSymbol("ADA-USD")).toBe(false);
  });

  test("mixed email + global-push (ntfy:<global topic>) → BOTH config and checker mirror", async () => {
    const res = await handleRequest(req("POST", "/alerts", {
      symbol: "AVAX-USD",
      reasoning: "phone push AND email",
      conditions: [{ condition: "below", value: 20 }],
      channels: ["email:you@example.com", "ntfy:mkt-testglobal"],
    }));
    expect(res.status).toBe(201);
    const created = await res.json() as any;

    // Projected to the daemon (it delivers the global ntfy push)…
    expect(configHasSymbol("AVAX-USD")).toBe(true);
    // …and mirrored to the checker for the email route ONLY (global topic stripped).
    const job = loadJobs().find(j => j.id === created.id)!;
    expect(job).toBeTruthy();
    expect(resolveChannelSpec(job)).toBe("email:you@example.com");
  });

  test("default push (no channels) → config, NO checker mirror", async () => {
    const before = loadJobs().length;
    const res = await handleRequest(req("POST", "/alerts", {
      symbol: "DOT-USD",
      reasoning: "plain phone push",
      conditions: [{ condition: "below", value: 5 }],
    }));
    expect(res.status).toBe(201);
    expect(configHasSymbol("DOT-USD")).toBe(true);
    expect(loadJobs().length).toBe(before); // nothing mirrored
  });

  test("GET /alerts lists a meta-only checker alert (daemon unreachable)", async () => {
    // No mkt daemon runs in tests, so handleGetAlerts falls back to meta-only —
    // the email-only LINK-USD alert must still appear in the list.
    const res = await handleRequest(req("GET", "/alerts"));
    expect(res.status).toBe(200);
    const list = await res.json() as any[];
    expect(list.some(a => a.symbol === "LINK-USD")).toBe(true);
  });

  test("DELETE of an email-only alert cleans meta AND the checker store", async () => {
    const target = loadJobs().find(j => j.symbol === "LINK-USD")!;
    const res = await handleRequest(req("DELETE", `/alerts/${target.id}`));
    expect(res.status).toBe(200);
    expect(loadJobs().find(j => j.id === target.id)).toBeUndefined();
    expect(loadMeta().find(m => m.id === target.id)).toBeUndefined();
    // GET no longer lists it.
    const list = await (await handleRequest(req("GET", "/alerts"))).json() as any[];
    expect(list.some(a => a.id === target.id)).toBe(false);
  });

  test("DELETE of a checker-only alert must NOT strip a same-symbol/same-conditions daemon rule", async () => {
    const SYM = "SAMEcond-USD";
    const conditions = [{ condition: "below", value: 42 }];
    const configRuleCount = () =>
      (readFileSync(MKT_CONFIG, "utf8").match(new RegExp(SYM, "g")) ?? []).length;

    // 1) A default-push alert → projected to the daemon config (one rule for SYM).
    const pushRes = await handleRequest(req("POST", "/alerts", {
      symbol: SYM, reasoning: "global phone push", conditions,
    }));
    expect(pushRes.status).toBe(201);
    expect(configRuleCount()).toBe(1);

    // 2) An email-only alert with the IDENTICAL symbol + conditions → checker/meta
    //    only, never projected to config.
    const emailRes = await handleRequest(req("POST", "/alerts", {
      symbol: SYM, reasoning: "same trigger, but email me instead", conditions,
      channels: ["email:you@example.com"],
    }));
    expect(emailRes.status).toBe(201);
    const emailAlert = await emailRes.json() as any;
    expect(configRuleCount()).toBe(1); // still just the default-push rule

    // 3) Deleting the checker-only alert must leave the default-push rule intact —
    //    a naive conditionsMatch filter would strip the wrong rule (Finding 3).
    const delRes = await handleRequest(req("DELETE", `/alerts/${emailAlert.id}`));
    expect(delRes.status).toBe(200);
    expect(loadJobs().find(j => j.id === emailAlert.id)).toBeUndefined(); // checker job gone
    expect(configRuleCount()).toBe(1);                                    // daemon rule survives
  });
});

describe("POST channel validation + fail-loud persistence", () => {
  // Finding 5: a bare channel prefix (`ntfy:`, `email:`, …) carries no target. It
  // used to pass validation, then post to an empty destination and still be marked
  // fired — silently dropping the alert. Reject it at the door instead.
  for (const bad of ["ntfy:", "email:", "telegram:", "telegram-bot:"]) {
    test(`rejects bare channel "${bad}" (no target) with 400`, async () => {
      const res = await handleRequest(req("POST", "/alerts", {
        symbol: "BARE-USD",
        reasoning: "should never be created",
        conditions: [{ condition: "below", value: 1 }],
        channels: [bad],
      }));
      expect(res.status).toBe(400);
      // Nothing persisted anywhere.
      expect(loadJobs().some(j => j.symbol === "BARE-USD")).toBe(false);
      expect(loadMeta().some(m => m.symbol === "BARE-USD")).toBe(false);
    });
  }

  test('accepts bare "stdout" (the only prefixless channel)', async () => {
    const res = await handleRequest(req("POST", "/alerts", {
      symbol: "STDOUT-USD",
      reasoning: "log to stdout",
      conditions: [{ condition: "below", value: 1 }],
      channels: ["stdout"],
    }));
    expect(res.status).toBe(201);
  });

  // Finding 2: when the checker mirror cannot be persisted (corrupt store), the API
  // must FAIL LOUD (500) rather than return 201 for an alert that can never fire.
  test("checker-mirror persistence failure returns 500, not a false 201", async () => {
    const good = readFileSync(STORE_PATH, "utf8");
    try {
      writeFileSync(STORE_PATH, "{ this is not valid json"); // corrupt the store
      const res = await handleRequest(req("POST", "/alerts", {
        symbol: "FAILLOUD-USD",
        reasoning: "email route needs a healthy checker store",
        conditions: [{ condition: "below", value: 1 }],
        channels: ["email:you@example.com"],
      }));
      expect(res.status).toBe(500);
      // Meta must not have been written either (mirror is persisted first, so its
      // failure aborts before any meta/config write).
      expect(loadMeta().some(m => m.symbol === "FAILLOUD-USD")).toBe(false);
    } finally {
      writeFileSync(STORE_PATH, good); // restore for any later tests
    }
  });
});
