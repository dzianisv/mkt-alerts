#!/usr/bin/env bun
// Unit tests for the alert dispatch layer. Run: bun test scripts/check.test.ts
// No real emails/pushes are sent — the transport fetch is mocked.

import { test, expect, describe, afterEach } from "bun:test";
import { buildAlertMessage, sendEmail, sendBrevoEmail, notify, type AlertMessage } from "./check.ts";
import type { AlertJob } from "./store.ts";

function job(overrides: Partial<AlertJob> = {}): AlertJob {
  return {
    id: "btc-below-90000-abcd",
    desk: "crypto",
    symbol: "BTC-USD",
    conditions: [{ condition: "below", value: 90000 }],
    reasoning: "Support break — invalidates bull thesis",
    channel: "email:you@example.com",
    created: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

const TS = "2026-07-18T12:34:56.000Z";

describe("buildAlertMessage", () => {
  test("subject is symbol + condition", () => {
    const m = buildAlertMessage(job(), 88123.45, TS);
    expect(m.subject).toBe("🔔 BTC-USD: below @ 90000");
  });

  test("body carries reason, current value and trigger", () => {
    const m = buildAlertMessage(job({ analysisLink: "https://notion.so/x" }), 88123.45, TS);
    expect(m.body).toContain("Why: Support break — invalidates bull thesis"); // thesis
    expect(m.body).toContain("Current:  88123.45");                            // current value
    expect(m.body).toContain("Trigger:  below @ 90000");                       // trigger
    expect(m.body).toContain("Analysis: https://notion.so/x");                 // link
  });

  test("compound conditions join with AND", () => {
    const m = buildAlertMessage(
      job({ conditions: [{ condition: "rsi_below", value: 30 }, { condition: "below", value: 200 }] }),
      195,
      TS
    );
    expect(m.subject).toBe("🔔 BTC-USD: rsi_below @ 30 AND below @ 200");
  });
});

describe("sendBrevoEmail (mocked transport)", () => {
  test("posts the right Brevo payload without a real send", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: any, init: any) => {
      captured = { url: String(url), init };
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;

    const res = await sendBrevoEmail({
      to: "you@example.com",
      subject: "🔔 BTC-USD: below @ 90000",
      body: "Why: Support break",
      apiKey: "xkeysib_test_key",
      from: "alerts@agentlabs.cc",
      fetchImpl,
    });

    expect(res.ok).toBe(true);
    expect(captured!.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((captured!.init.headers as any)["api-key"]).toBe("xkeysib_test_key");
    expect((captured!.init.headers as any)["content-type"]).toBe("application/json");
    const payload = JSON.parse(captured!.init.body as string);
    expect(payload.sender).toEqual({ email: "alerts@agentlabs.cc" });
    expect(payload.to).toEqual([{ email: "you@example.com" }]);
    expect(payload.subject).toBe("🔔 BTC-USD: below @ 90000");
    expect(payload.textContent).toBe("Why: Support break");
  });

  test("propagates a non-ok status", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const res = await sendBrevoEmail({
      to: "x@y.com", subject: "s", body: "b", apiKey: "k", from: "f@g.com", fetchImpl,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });
});

describe("sendEmail (mocked transport)", () => {
  test("posts the right Resend payload without a real send", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: any, init: any) => {
      captured = { url: String(url), init };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await sendEmail({
      to: "you@example.com",
      subject: "🔔 BTC-USD: below @ 90000",
      body: "Why: Support break",
      apiKey: "re_test_key",
      from: "alerts@agentlabs.cc",
      fetchImpl,
    });

    expect(res.ok).toBe(true);
    expect(captured!.url).toBe("https://api.resend.com/emails");
    expect((captured!.init.headers as any).Authorization).toBe("Bearer re_test_key");
    const payload = JSON.parse(captured!.init.body as string);
    expect(payload.from).toBe("alerts@agentlabs.cc");
    expect(payload.to).toEqual(["you@example.com"]);
    expect(payload.subject).toBe("🔔 BTC-USD: below @ 90000");
    expect(payload.text).toBe("Why: Support break");
  });

  test("propagates a non-ok status", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 422 })) as unknown as typeof fetch;
    const res = await sendEmail({
      to: "x@y.com", subject: "s", body: "b", apiKey: "k", from: "f@g.com", fetchImpl,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(422);
  });
});

describe("notify — email channel end to end", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.BREVO_API_KEY;
    delete process.env.ALERT_EMAIL;
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_EMAIL_FROM;
    delete process.env.NTFY_TOPIC;
    delete process.env.NTFY_SERVER;
  });

  test("email: sends via Brevo when BREVO_API_KEY set (primary, over ntfy + Resend)", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers, body: init.body });
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    process.env.BREVO_API_KEY = "xkeysib_test_key";
    process.env.ALERT_EMAIL_FROM = "alerts@agentlabs.cc";
    // ntfy + Resend both present but must NOT be used — Brevo wins
    process.env.NTFY_TOPIC = "mkt-topic-abc";
    process.env.RESEND_API_KEY = "re_test_key";

    const msg = buildAlertMessage(job(), 88000, TS);
    await notify("email:you@example.com", msg);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(calls[0].headers["api-key"]).toBe("xkeysib_test_key");
    const payload = JSON.parse(calls[0].body);
    expect(payload.sender).toEqual({ email: "alerts@agentlabs.cc" });
    expect(payload.to).toEqual([{ email: "you@example.com" }]);
    expect(payload.subject).toBe("🔔 BTC-USD: below @ 90000");
    expect(payload.textContent).toContain("Support break");
    // neither fallback touched
    expect(calls.some(c => c.url.includes("ntfy.sh"))).toBe(false);
    expect(calls.some(c => c.url.includes("api.resend.com"))).toBe(false);
  });

  test("email: Brevo sender falls back to ALERT_EMAIL when ALERT_EMAIL_FROM unset", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: init.body });
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    process.env.BREVO_API_KEY = "xkeysib_test_key";
    process.env.ALERT_EMAIL = "sender@agentlabs.cc";

    const msg = buildAlertMessage(job(), 88000, TS);
    await notify("email:you@example.com", msg);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body).sender).toEqual({ email: "sender@agentlabs.cc" });
  });

  test("email: publishes to ntfy with an Email header (ntfy-native, no Resend)", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers, body: init.body });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    process.env.NTFY_TOPIC = "mkt-topic-abc";
    process.env.RESEND_API_KEY = "re_test_key"; // present but must NOT be used

    const msg = buildAlertMessage(job(), 88000, TS);
    await notify("email:you@example.com", msg);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ntfy.sh/mkt-topic-abc");
    expect(calls[0].headers.Email).toBe("you@example.com");
    expect(calls[0].headers.Title).toBe("BTC-USD: below @ 90000"); // emoji stripped (latin-1 headers)
    expect(calls[0].body).toContain("Support break");
    // Resend must not be touched when ntfy is available
    expect(calls.some(c => c.url.includes("api.resend.com"))).toBe(false);
  });

  test("email: falls back to Resend when no NTFY_TOPIC but RESEND_API_KEY set", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), payload: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    // NTFY_TOPIC intentionally unset
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.ALERT_EMAIL_FROM = "alerts@agentlabs.cc";

    const msg = buildAlertMessage(job(), 88000, TS);
    await notify("email:you@example.com", msg);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].payload.to).toEqual(["you@example.com"]);
    expect(calls[0].payload.text).toContain("Support break");
  });

  test("multiple channels (email + ntfy push) both dispatch", async () => {
    const hits: { url: string; email?: string }[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      hits.push({ url: String(url), email: init?.headers?.Email });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    process.env.NTFY_TOPIC = "mkt-topic-abc";

    const msg = buildAlertMessage(job(), 88000, TS);
    await notify("email:you@example.com,ntfy:my-topic", msg);

    // email → ntfy topic from env, WITH Email header
    expect(hits.some(h => h.url === "https://ntfy.sh/mkt-topic-abc" && h.email === "you@example.com")).toBe(true);
    // ntfy push → topic from the channel spec, no Email header
    expect(hits.some(h => h.url.includes("ntfy.sh/my-topic"))).toBe(true);
  });

  test("no NTFY_TOPIC and no RESEND_API_KEY → falls back to stdout, no network call", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    // both NTFY_TOPIC and RESEND_API_KEY intentionally unset

    const msg = buildAlertMessage(job(), 88000, TS);
    await notify("email:you@example.com", msg);
    expect(called).toBe(false);
  });
});
