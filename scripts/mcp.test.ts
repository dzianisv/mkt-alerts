/**
 * End-to-end tests for the `mcp` subcommand: drives the REAL server over stdio
 * (newline-delimited JSON-RPC 2.0) against a stub mkt daemon (node http, no Bun
 * APIs). Verifies the handshake, tools/list, and each tool call — including the
 * price/data_source hard gate.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createServer, type Server } from "http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

let httpServer: Server;
let port = 0;
let tmp = "";
let child: ChildProcessWithoutNullStreams;

let sawAuthHeader = false;

// ── Stub mkt daemon ────────────────────────────────────────────────────────────
function startStubDaemon(): Promise<number> {
  return new Promise((resolve) => {
    httpServer = createServer((req, res) => {
      const auth = req.headers["authorization"];
      if (auth !== "Bearer test-token") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      sawAuthHeader = true;

      const url = req.url || "";
      const method = req.method || "GET";

      if (method === "GET" && url === "/alerts") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([
          {
            id: "btc-usd-below-90000-a1b2",
            symbol: "BTC-USD",
            conditions: [{ condition: "below", value: 90000 }],
            reasoning: "support",
            enabled: true,
          },
        ]));
        return;
      }

      if (method === "POST" && url === "/alerts") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          let parsed: any = {};
          try { parsed = JSON.parse(raw); } catch { /* echo empty */ }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "created-id-xyz", ...parsed }));
        });
        return;
      }

      if (method === "DELETE" && url.startsWith("/alerts/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

// ── stdio JSON-RPC driver ───────────────────────────────────────────────────────
const pending = new Map<number, (msg: any) => void>();
let stdoutBuf = "";

function attachReader(proc: ChildProcessWithoutNullStreams): void {
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx: number;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });
}

function send(obj: unknown): void {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function request(obj: { id: number; [k: string]: unknown }, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(obj.id);
      reject(new Error(`timeout waiting for response id=${obj.id}`));
    }, timeoutMs);
    pending.set(obj.id, (msg) => { clearTimeout(timer); resolve(msg); });
    send(obj);
  });
}

beforeAll(async () => {
  await startStubDaemon();

  tmp = mkdtempSync(join(tmpdir(), "mkt-mcp-test-"));
  mkdirSync(join(tmp, ".config", "mkt-watch"), { recursive: true });
  writeFileSync(
    join(tmp, ".config", "mkt-watch", "auth.json"),
    JSON.stringify({ apiUrl: `http://127.0.0.1:${port}`, token: "test-token" })
  );

  child = spawn("bun", ["mkt-alerts.ts", "mcp"], {
    cwd: repoRoot,
    env: { ...process.env, HOME: tmp },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  attachReader(child);
});

afterAll(() => {
  try { child?.kill(); } catch { /* already gone */ }
  try { httpServer?.close(); } catch { /* already closed */ }
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test("initialize handshake returns serverInfo and tools capability", async () => {
  const res = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  expect(res.result.serverInfo.name).toBe("mkt-alerts");
  expect(res.result.capabilities.tools).toBeDefined();
  expect(res.result.protocolVersion).toBe("2024-11-05");

  // notification: no response expected
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
});

test("tools/list returns the three tools", async () => {
  const res = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = res.result.tools.map((t: any) => t.name).sort();
  expect(names).toEqual(["add_alert", "list_alerts", "remove_alert"]);
});

test("list_alerts returns the canned alert", async () => {
  const res = await request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_alerts", arguments: {} },
  });
  expect(res.result.isError).toBeFalsy();
  expect(res.result.content[0].text).toContain("btc-usd-below-90000-a1b2");
  expect(sawAuthHeader).toBe(true);
});

test("add_alert with rsi_below succeeds (no data_source needed) and upper-cases symbol", async () => {
  const res = await request({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "add_alert",
      arguments: {
        symbol: "eth-usd",
        reason: "oversold bounce",
        conditions: [{ condition: "rsi_below", value: 30 }],
      },
    },
  });
  expect(res.result.isError).toBeFalsy();
  const echoed = JSON.parse(res.result.content[0].text);
  expect(echoed.symbol).toBe("ETH-USD");
  expect(echoed.id).toBe("created-id-xyz");
});

test("add_alert with above and no data_source is rejected (hard gate)", async () => {
  const res = await request({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "add_alert",
      arguments: {
        symbol: "BTC-USD",
        reason: "reclaim",
        conditions: [{ condition: "above", value: 100000 }],
      },
    },
  });
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text.toLowerCase()).toContain("data source");
});

test("add_alert with above + data_source succeeds and stamps reasoning", async () => {
  const res = await request({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "add_alert",
      arguments: {
        symbol: "BTC-USD",
        reason: "reclaim entry",
        conditions: [{ condition: "above", value: 100000 }],
        data_source: "210w OHLCV from TradingView",
      },
    },
  });
  expect(res.result.isError).toBeFalsy();
  const echoed = JSON.parse(res.result.content[0].text);
  expect(echoed.reasoning).toBe("reclaim entry [data: 210w OHLCV from TradingView]");
});

test("remove_alert returns text containing the id", async () => {
  const res = await request({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "remove_alert", arguments: { id: "some-alert-id" } },
  });
  expect(res.result.isError).toBeFalsy();
  expect(res.result.content[0].text).toContain("some-alert-id");
});

test("unknown method with id returns JSON-RPC -32601", async () => {
  const res = await request({ jsonrpc: "2.0", id: 8, method: "does/not/exist" });
  expect(res.error.code).toBe(-32601);
});
