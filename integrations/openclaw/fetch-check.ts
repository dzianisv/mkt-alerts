/**
 * Live data-fetch proof. Exercises the plugin's REAL fetchJobData against the
 * public Coinbase (crypto) and Yahoo Finance (stocks) endpoints — no keys, no
 * GCP. Run: node --experimental-strip-types fetch-check.ts
 */
import { fetchJobData, type AlertJob } from "./index.ts";

const crypto: AlertJob = {
  id: "btc",
  desk: "crypto",
  symbol: "BTC-USD",
  conditions: [{ condition: "rsi_above", value: 70, period: 14 }],
  reasoning: "probe",
};

const stock: AlertJob = {
  id: "aapl",
  desk: "stocks",
  symbol: "AAPL",
  conditions: [{ condition: "rsi_above", value: 70, period: 14 }],
  reasoning: "probe",
};

function summarize(label: string, d: { price: number; changePct?: number; closes?: number[] }) {
  const closes = d.closes ?? [];
  console.log(`\n[${label}]`);
  console.log(`  price      = ${d.price}`);
  console.log(`  changePct  = ${d.changePct?.toFixed(3)}%`);
  console.log(`  closes.len = ${closes.length}`);
  console.log(`  closes.tail= ${JSON.stringify(closes.slice(-4))}`);
}

async function main() {
  const btc = await fetchJobData(crypto);
  summarize("Coinbase BTC-USD", btc);
  if (!Number.isFinite(btc.price)) throw new Error("BTC price not finite");
  if ((btc.closes?.length ?? 0) < 35) throw new Error("BTC closes too short for MACD");

  const aapl = await fetchJobData(stock);
  summarize("Yahoo AAPL", aapl);
  if (!Number.isFinite(aapl.price)) throw new Error("AAPL price not finite");
  if ((aapl.closes?.length ?? 0) < 35) throw new Error("AAPL closes too short for MACD");

  console.log("\nLIVE-FETCH PASS: both public sources returned a finite price and >=35 daily closes.");
}

main().catch((e) => {
  console.error("LIVE-FETCH FAIL:", e);
  process.exit(1);
});
