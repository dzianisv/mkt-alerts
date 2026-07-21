# pine-runner

Isolated subprocess that executes Pine Script v5 programs via [`pinets`](https://www.npmjs.com/package/pinets)
(LuxAlgo PineTS). Invoked by a future daemon as an external child process —
never imported in-process.

## Contract

- stdin: one JSON object `{ script, candles, signalPlot? }` — `candles` are
  oldest-first `{open,high,low,close,volume,openTime}` objects; `signalPlot`
  defaults to `"signal"`.
- stdout: exactly one JSON line — `{ ok:true, signalPlot, bars, last, prev,
  truthy, crossedUp, crossedDown, plots }` on success, or `{ ok:false, error,
  available? }` on failure (exit code 1). Diagnostics go to stderr only.

## License

**AGPL-3.0-only** (inherited from `pinets`). This package is isolated on
purpose: it is **NOT part of the MIT `@vibetechnologies/mkt-alerts` npm
package** and must never be imported by `mkt-alerts.ts` or listed as a
dependency in the root `package.json`.

## Usage

```
bun install && bun run selftest
```
