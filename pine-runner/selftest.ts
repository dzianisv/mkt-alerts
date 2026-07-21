// pine-runner/selftest.ts
//
// Self-contained test harness for run.ts. Spawns run.ts as a real child
// process (stdin/stdout subprocess boundary) — this is the same boundary a
// production daemon will use, so the test proves the subprocess contract
// works end-to-end, not just that PineTS works in-process.
//
// Run with: bun run selftest.ts   (or `bun run selftest` per package.json)

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
}

interface RunResult {
  ok: boolean;
  signalPlot?: string;
  bars?: number;
  last?: number;
  prev?: number | null;
  truthy?: boolean;
  crossedUp?: boolean;
  crossedDown?: boolean;
  plots?: string[];
  error?: string;
  available?: string[];
}

const BAR_COUNT = 120;
const BASE_PRICE = 100;
const DRIFT_PER_BAR = 0.05;
const AMPLITUDE = 8;
const PERIOD_BARS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const START_OPEN_TIME = Date.UTC(2020, 0, 1);

/**
 * Deterministic ~120-bar synthetic OHLCV fixture: sine wave (amplitude 8,
 * period 20 bars) plus a small linear drift on top of a 100 base price.
 * These parameters were verified independently (plain SMA(10)/SMA(30) math,
 * outside of PineTS) to produce multiple zero-crossings of the SMA(10)-SMA(30)
 * difference across the series before wiring up the subprocess test below.
 */
function buildFixture(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const close =
      BASE_PRICE +
      DRIFT_PER_BAR * i +
      AMPLITUDE * Math.sin((2 * Math.PI * i) / PERIOD_BARS);
    const open = close - 0.1;
    const high = close + 1;
    const low = close - 1;
    const volume = 1000 + i;
    const openTime = START_OPEN_TIME + i * DAY_MS;
    candles.push({ open, high, low, close, volume, openTime });
  }
  return candles;
}

/** Independently computed SMA(10)-SMA(30) sign changes, for sanity only. */
function sma(values: number[], length: number, index: number): number | null {
  if (index < length - 1) return null;
  let sum = 0;
  for (let k = index - length + 1; k <= index; k++) sum += values[k];
  return sum / length;
}

function independentCrossingCheck(candles: Candle[]): {
  upAt: number[];
  downAt: number[];
} {
  const closes = candles.map((c) => c.close);
  const diffs: (number | null)[] = closes.map((_, i) => {
    const fast = sma(closes, 10, i);
    const slow = sma(closes, 30, i);
    return fast != null && slow != null ? fast - slow : null;
  });
  const upAt: number[] = [];
  const downAt: number[] = [];
  for (let i = 1; i < diffs.length; i++) {
    const prev = diffs[i - 1];
    const cur = diffs[i];
    if (prev == null || cur == null) continue;
    if (prev <= 0 && cur > 0) upAt.push(i);
    if (prev > 0 && cur <= 0) downAt.push(i);
  }
  return { upAt, downAt };
}

async function spawnRun(payload: unknown): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run.ts"], {
    cwd: import.meta.dir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length !== 1) {
    throw new Error(
      `expected exactly one stdout line, got ${lines.length}. stdout=${JSON.stringify(
        stdout
      )} stderr=${JSON.stringify(stderr)}`
    );
  }
  return JSON.parse(lines[0]);
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const fixture = buildFixture();

  const { upAt, downAt } = independentCrossingCheck(fixture);
  console.log(
    `[selftest] independent SMA(10)-SMA(30) crossing check: upAt=${JSON.stringify(
      upAt
    )} downAt=${JSON.stringify(downAt)}`
  );
  assert(upAt.length > 0, "independent check found no upward crossings — fixture params need tuning");
  assert(downAt.length > 0, "independent check found no downward crossings — fixture params need tuning");

  const smaScript =
    '//@version=5\nindicator("t")\nfast=ta.sma(close,10)\nslow=ta.sma(close,30)\nsignal = fast - slow\nplot(signal,"signal")';

  console.log("[selftest] running full 120-bar fixture through run.ts subprocess...");
  const fullResult = await spawnRun({
    script: smaScript,
    candles: fixture,
    signalPlot: "signal",
  });
  console.log("[selftest] full-run result:", JSON.stringify(fullResult));

  assert(fullResult.ok === true, `expected ok===true, got ${JSON.stringify(fullResult)}`);
  assert(fullResult.bars === BAR_COUNT, `expected bars===${BAR_COUNT}, got ${fullResult.bars}`);

  console.log(
    `[selftest] proving crossing detection through the real subprocess boundary (k=31..${BAR_COUNT})...`
  );
  let sawCrossedUp = false;
  let sawCrossedDown = false;
  const crossedUpAtK: number[] = [];
  const crossedDownAtK: number[] = [];

  for (let k = 31; k <= BAR_COUNT; k++) {
    const sliced = fixture.slice(0, k);
    const result = await spawnRun({
      script: smaScript,
      candles: sliced,
      signalPlot: "signal",
    });
    assert(result.ok === true, `k=${k}: expected ok===true, got ${JSON.stringify(result)}`);
    if (result.crossedUp) {
      sawCrossedUp = true;
      crossedUpAtK.push(k);
    }
    if (result.crossedDown) {
      sawCrossedDown = true;
      crossedDownAtK.push(k);
    }
  }

  console.log(`[selftest] crossedUp observed at k=${JSON.stringify(crossedUpAtK)}`);
  console.log(`[selftest] crossedDown observed at k=${JSON.stringify(crossedDownAtK)}`);

  assert(sawCrossedUp, "subprocess never reported crossedUp===true across k=31..120");
  assert(sawCrossedDown, "subprocess never reported crossedDown===true across k=31..120");

  console.log("[selftest] running truthy===true smoke test with a constant-positive script...");
  const constScript =
    '//@version=5\nindicator("t2")\nsignal = 1\nplot(signal,"signal")';
  const truthyResult = await spawnRun({
    script: constScript,
    candles: fixture,
    signalPlot: "signal",
  });
  console.log("[selftest] truthy-test result:", JSON.stringify(truthyResult));
  assert(truthyResult.ok === true, `expected ok===true, got ${JSON.stringify(truthyResult)}`);
  assert(truthyResult.truthy === true, `expected truthy===true, got ${JSON.stringify(truthyResult)}`);

  console.log("");
  console.log("=== ALL PASSED ===");
  console.log(
    `full-run: ok=${fullResult.ok} bars=${fullResult.bars} | ` +
      `crossings proven via subprocess: crossedUp@${JSON.stringify(
        crossedUpAtK
      )} crossedDown@${JSON.stringify(crossedDownAtK)} | ` +
      `truthy-test: ok=${truthyResult.ok} truthy=${truthyResult.truthy}`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[selftest] unexpected error:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
