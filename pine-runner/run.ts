// pine-runner/run.ts
//
// Isolated AGPL-3.0 subprocess runner. Reads a single JSON payload from
// stdin, executes a Pine Script v5 program against the supplied candles
// using PineTS, and writes exactly one JSON line to stdout describing the
// requested signal plot.
//
// Contract (see pine-runner/README.md):
//   stdin:  { script: string, candles: Candle[], signalPlot?: string }
//   stdout: exactly one JSON line, either
//     { ok: true,  signalPlot, bars, last, prev, truthy, crossedUp, crossedDown, plots }
//     { ok: false, error, available? }
//
// No network calls, no filesystem access beyond stdio, no imports from the
// rest of the mkt-alerts repo. Diagnostics go to stderr only.

import { PineTS } from "pinets";

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
}

interface RunRequest {
  script: string;
  candles: Candle[];
  signalPlot?: string;
}

interface OkResult {
  ok: true;
  signalPlot: string;
  bars: number;
  last: number;
  prev: number | null;
  truthy: boolean;
  crossedUp: boolean;
  crossedDown: boolean;
  plots: string[];
}

interface ErrResult {
  ok: false;
  error: string;
  available?: string[];
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeStdout(result: OkResult | ErrResult): void {
  process.stdout.write(JSON.stringify(result) + "\n");
}

async function main(): Promise<void> {
  const raw = await readStdin();

  let request: RunRequest;
  try {
    request = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `invalid JSON on stdin: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!request || typeof request !== "object") {
    throw new Error("request must be a JSON object");
  }
  if (typeof request.script !== "string" || request.script.length === 0) {
    throw new Error("request.script must be a non-empty string");
  }
  if (!Array.isArray(request.candles) || request.candles.length === 0) {
    throw new Error("request.candles must be a non-empty array");
  }

  const signalPlot = request.signalPlot ?? "signal";

  const pineTS = new PineTS(request.candles as any);
  const { plots } = await pineTS.run(request.script);

  const plotNames = Object.keys(plots);

  if (!Object.prototype.hasOwnProperty.call(plots, signalPlot)) {
    const err: ErrResult = {
      ok: false,
      error: `signal plot "${signalPlot}" not found`,
      available: plotNames,
    };
    writeStdout(err);
    process.exit(1);
    return;
  }

  const data = plots[signalPlot].data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`signal plot "${signalPlot}" produced no data`);
  }

  const last = data[data.length - 1].value;
  const prev = data.length >= 2 ? data[data.length - 2].value : null;
  const truthy = last > 0;
  const crossedUp = prev != null && prev <= 0 && last > 0;
  const crossedDown = prev != null && prev > 0 && last <= 0;

  const result: OkResult = {
    ok: true,
    signalPlot,
    bars: data.length,
    last,
    prev,
    truthy,
    crossedUp,
    crossedDown,
    plots: plotNames,
  };
  writeStdout(result);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`pine-runner error: ${message}`);
  const result: ErrResult = { ok: false, error: message };
  writeStdout(result);
  process.exit(1);
});
