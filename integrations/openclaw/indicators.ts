// Pure technical-indicator math, ported verbatim from the MIT-licensed
// mkt-alerts `scripts/indicators.ts`. No I/O, no dependencies — safe to embed.

/** Simple moving average of the last `period` values. */
export function sma(closes: number[], period: number): number {
  if (closes.length < period) throw new Error(`sma: need ${period} closes, got ${closes.length}`);
  const slice = closes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

/**
 * Wilder's RSI (standard 14-period).
 * Seeds with SMA of the first `period` up/down moves, then applies
 * Wilder smoothing: avgGain = (prev*(period-1) + cur) / period.
 */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1)
    throw new Error(`rsi: need at least ${period + 1} closes, got ${closes.length}`);

  const changes = closes.slice(1).map((c, i) => c - closes[i]);

  // Seed: plain average of first `period` moves
  const seed = changes.slice(0, period);
  let avgGain = seed.reduce((s, d) => s + Math.max(d, 0), 0) / period;
  let avgLoss = seed.reduce((s, d) => s + Math.max(-d, 0), 0) / period;

  // Wilder smoothing for any bars beyond the seed window
  for (const d of changes.slice(period)) {
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * EMA-based MACD.
 * Returns the latest macd, signal, histogram, and the *previous* bar's histogram
 * so callers can detect a sign flip (cross).
 */
export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: number; signal: number; hist: number; prevHist: number } {
  if (closes.length < slow + signal)
    throw new Error(`macd: need at least ${slow + signal} closes, got ${closes.length}`);

  const emaOf = (data: number[], len: number): number[] => {
    const k = 2 / (len + 1);
    const out: number[] = [];
    // seed with SMA of first `len` values
    let val = data.slice(0, len).reduce((s, v) => s + v, 0) / len;
    out.push(val);
    for (const v of data.slice(len)) {
      val = v * k + val * (1 - k);
      out.push(val);
    }
    return out;
  };

  const fastEma = emaOf(closes, fast);
  const slowEma = emaOf(closes, slow);

  // Align: slow EMA is shorter; the last N values correspond to the same bars
  const len = Math.min(fastEma.length, slowEma.length);
  const macdLine = Array.from({ length: len }, (_, i) =>
    fastEma[fastEma.length - len + i] - slowEma[slowEma.length - len + i],
  );

  const signalLine = emaOf(macdLine, signal);

  const hist = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];
  const prevMacd = macdLine[macdLine.length - 2];
  const prevSig = signalLine[signalLine.length - 2] ?? signalLine[signalLine.length - 1];
  const prevHist = prevMacd - prevSig;

  return {
    macd: macdLine[macdLine.length - 1],
    signal: signalLine[signalLine.length - 1],
    hist,
    prevHist,
  };
}
