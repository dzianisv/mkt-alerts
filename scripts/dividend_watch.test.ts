#!/usr/bin/env bun
// Unit tests for dividend_watch's layered email delivery. No real emails/pushes
// are sent — the transport fetch is injected. Run: bun test scripts/dividend_watch.test.ts

import { test, expect, describe } from "bun:test";
import { deliverEmail, type DivEmailEnv } from "./dividend_watch.ts";

function env(overrides: Partial<DivEmailEnv> = {}): DivEmailEnv {
  return {
    brevoKey: "xkeysib_test",
    from: "vibeteaichnologies@gmail.com",
    to: "you@example.com",
    ntfyTopic: "mytopic",
    ntfyServer: "https://ntfy.sh",
    ...overrides,
  };
}

describe("dividend_watch.deliverEmail — layered fall-through", () => {
  test("Brevo 201 stops the chain", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: any) => { calls.push(String(url)); return new Response("{}", { status: 201 }); }) as unknown as typeof fetch;
    const res = await deliverEmail("subj", "body", env(), fetchImpl);
    expect(res).toBe("brevo");
    expect(calls).toEqual(["https://api.brevo.com/v3/smtp/email"]);
  });

  test("Brevo 400 falls through to ntfy-email", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: any) => {
      const u = String(url); calls.push(u);
      if (u.includes("brevo")) return new Response("bad", { status: 400 });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await deliverEmail("subj", "body", env(), fetchImpl);
    expect(res).toBe("ntfy");
    expect(calls[0]).toBe("https://api.brevo.com/v3/smtp/email");
    expect(calls[1]).toBe("https://ntfy.sh/mytopic");
  });

  test("Brevo thrown fetch falls through to ntfy-email", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: any) => {
      const u = String(url); calls.push(u);
      if (u.includes("brevo")) throw new Error("network down");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await deliverEmail("subj", "body", env(), fetchImpl);
    expect(res).toBe("ntfy");
    expect(calls[1]).toBe("https://ntfy.sh/mytopic");
  });

  test("Brevo fail + no ntfy topic → stdout, never throws", async () => {
    const fetchImpl = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const res = await deliverEmail("subj", "body", env({ ntfyTopic: undefined }), fetchImpl);
    expect(res).toBe("stdout");
  });

  test("Brevo not usable (no verified sender) → 'none' so pushNtfy owns email (no double send)", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("{}", { status: 201 }); }) as unknown as typeof fetch;
    const res = await deliverEmail("subj", "body", env({ from: undefined }), fetchImpl);
    expect(res).toBe("none");
    expect(called).toBe(false); // never sends from an unverified/recipient address
  });

  test("no recipient → 'none' (email disabled)", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("{}", { status: 201 }); }) as unknown as typeof fetch;
    const res = await deliverEmail("subj", "body", env({ to: undefined }), fetchImpl);
    expect(res).toBe("none");
    expect(called).toBe(false);
  });
});
