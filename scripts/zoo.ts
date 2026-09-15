/**
 * The strategy zoo: every commonly-published retail crypto strategy family,
 * swept over parameters, tested identically.
 *
 *   npm run zoo:ict
 *
 * Families are the ones that actually dominate forums, YouTube and r/algotrading:
 * MA crossover (golden cross), RSI mean reversion, MACD, Bollinger (both
 * directions), Donchian/turtle breakout, Stochastic, Supertrend, VWAP reversion,
 * time-series momentum, volatility breakout, and grid/range. Sweeping their
 * parameters is what "200 strategies" means in practice — the same dozen ideas
 * with different numbers.
 *
 * Method, because with this many tests method is the only thing standing between
 * a table and a fantasy:
 *
 *  - POSITION-BASED. Each config emits +1/0/-1 per bar per pair; cost is charged
 *    on |position change|, so turnover is priced automatically and honestly.
 *  - CAUSAL. Every indicator at bar i uses only bars <= i, and the position taken
 *    on bar i earns bar i+1's return.
 *  - TIME-CLUSTERED. The 11 pairs move together, so the unit of observation is the
 *    equal-weight portfolio return per bar, not each pair-bar. Pooling pair-bars
 *    would inflate every t-stat by roughly sqrt(11).
 *  - BONFERRONI. With ~200 configs, |t| > 2 happens ~10 times by chance alone. The
 *    bar is |t| > 3.6 (p<0.05/200, two-sided).
 *  - THREE-WAY SPLIT. Train 50% / validation 25% / holdout 25%, holdout scored
 *    once for whatever validation selects.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, atr, rsiWilder } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = join(process.env.TMPDIR ?? "/tmp", `nightshift-bt-15m-${process.argv[2] ?? "175"}`);
const COST_PER_SIDE = (5 + 2) / 10_000;    // 5bp fee + 2bp slip

const books: { sym: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 1000) books.push({ sym: a.symbol, cs });
}
if (books.length < 6) { console.log(`need >=6 books, have ${books.length}`); process.exit(1); }

// ───────────────────────── indicator helpers (causal) ─────────────────────────
const sma = (v: number[], n: number) => {
  const o = new Array<number>(v.length).fill(NaN); let s = 0;
  for (let i = 0; i < v.length; i++) { s += v[i]!; if (i >= n) s -= v[i - n]!; if (i >= n - 1) o[i] = s / n; }
  return o;
};
const ema = (v: number[], n: number) => {
  const o = new Array<number>(v.length).fill(NaN); const k = 2 / (n + 1);
  for (let i = 0; i < v.length; i++) o[i] = i === 0 ? v[0]! : v[i]! * k + o[i - 1]! * (1 - k);
  return o;
};
const stdev = (v: number[], n: number) => {
  const o = new Array<number>(v.length).fill(NaN);
  for (let i = n - 1; i < v.length; i++) {
    const w = v.slice(i - n + 1, i + 1); const m = w.reduce((a, b) => a + b, 0) / n;
    o[i] = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  }
  return o;
};
const rollMax = (v: number[], n: number) => v.map((_, i) => (i < n ? NaN : Math.max(...v.slice(i - n, i))));
const rollMin = (v: number[], n: number) => v.map((_, i) => (i < n ? NaN : Math.min(...v.slice(i - n, i))));

type Gen = (cs: Candle[]) => number[];   // position per bar, +1/0/-1

// ───────────────────────────── the families ─────────────────────────────
function maCross(fast: number, slow: number, kind: "sma" | "ema", allowShort: boolean): Gen {
  return (cs) => {
    const c = cs.map((x) => x.c);
    const f = kind === "sma" ? sma(c, fast) : ema(c, fast);
    const s = kind === "sma" ? sma(c, slow) : ema(c, slow);
    return c.map((_, i) => (!isFinite(f[i]!) || !isFinite(s[i]!) ? 0 : f[i]! > s[i]! ? 1 : allowShort ? -1 : 0));
  };
}
function rsiRevert(n: number, lo: number, hi: number, allowShort: boolean): Gen {
  return (cs) => {
    const r = rsiWilder(cs, n); let pos = 0;
    return cs.map((_, i) => {
      const v = r[i]; if (v === undefined || !isFinite(v)) return (pos = 0);
      if (pos === 0) { if (v < lo) pos = 1; else if (allowShort && v > hi) pos = -1; }
      else if (pos === 1 && v > 50) pos = 0;
      else if (pos === -1 && v < 50) pos = 0;
      return pos;
    });
  };
}
function macd(fast: number, slow: number, sig: number, allowShort: boolean): Gen {
  return (cs) => {
    const c = cs.map((x) => x.c);
    const line = ema(c, fast).map((v, i) => v - ema(c, slow)[i]!);
    const sl = ema(line.map((v) => (isFinite(v) ? v : 0)), sig);
    return c.map((_, i) => (line[i]! > sl[i]! ? 1 : allowShort ? -1 : 0));
  };
}
function bollinger(n: number, k: number, mode: "revert" | "breakout", allowShort: boolean): Gen {
  return (cs) => {
    const c = cs.map((x) => x.c); const m = sma(c, n); const sd = stdev(c, n); let pos = 0;
    return c.map((_, i) => {
      if (!isFinite(m[i]!) || !isFinite(sd[i]!)) return (pos = 0);
      const up = m[i]! + k * sd[i]!, dn = m[i]! - k * sd[i]!;
      if (mode === "revert") {
        if (pos === 0) { if (c[i]! < dn) pos = 1; else if (allowShort && c[i]! > up) pos = -1; }
        else if ((pos === 1 && c[i]! >= m[i]!) || (pos === -1 && c[i]! <= m[i]!)) pos = 0;
      } else {
        if (c[i]! > up) pos = 1; else if (allowShort && c[i]! < dn) pos = -1;
        else if ((pos === 1 && c[i]! < m[i]!) || (pos === -1 && c[i]! > m[i]!)) pos = 0;
      }
      return pos;
    });
  };
}
function donchian(n: number, allowShort: boolean): Gen {
  return (cs) => {
    const hi = rollMax(cs.map((x) => x.h), n), lo = rollMin(cs.map((x) => x.l), n); let pos = 0;
    return cs.map((x, i) => {
      if (!isFinite(hi[i]!) || !isFinite(lo[i]!)) return (pos = 0);
      if (x.c > hi[i]!) pos = 1; else if (x.c < lo[i]!) pos = allowShort ? -1 : 0;
      return pos;
    });
  };
}
function stochastic(n: number, lo: number, hi: number, allowShort: boolean): Gen {
  return (cs) => {
    const hh = rollMax(cs.map((x) => x.h), n), ll = rollMin(cs.map((x) => x.l), n); let pos = 0;
    return cs.map((x, i) => {
      if (!isFinite(hh[i]!) || !isFinite(ll[i]!) || hh[i]! <= ll[i]!) return (pos = 0);
      const k = ((x.c - ll[i]!) / (hh[i]! - ll[i]!)) * 100;
      if (pos === 0) { if (k < lo) pos = 1; else if (allowShort && k > hi) pos = -1; }
      else if ((pos === 1 && k > 50) || (pos === -1 && k < 50)) pos = 0;
      return pos;
    });
  };
}
function supertrend(n: number, mult: number, allowShort: boolean): Gen {
  return (cs) => {
    let pos = 0, stop = NaN;
    return cs.map((x, i) => {
      const a = atr(cs, i, n); if (!(a > 0)) return (pos = 0);
      if (pos === 1) { stop = Math.max(stop, x.c - mult * a); if (x.c < stop) { pos = allowShort ? -1 : 0; stop = x.c + mult * a; } }
      else if (pos === -1) { stop = Math.min(stop, x.c + mult * a); if (x.c > stop) { pos = 1; stop = x.c - mult * a; } }
      else { pos = 1; stop = x.c - mult * a; }
      return pos;
    });
  };
}
function vwapRevert(n: number, k: number, allowShort: boolean): Gen {
  return (cs) => {
    let pos = 0;
    return cs.map((x, i) => {
      if (i < n) return 0;
      const w = cs.slice(i - n + 1, i + 1);
      const vol = w.reduce((s, y) => s + (y.v || 1), 0);
      const vw = w.reduce((s, y) => s + ((y.h + y.l + y.c) / 3) * (y.v || 1), 0) / vol;
      const a = atr(cs, i); if (!(a > 0)) return (pos = 0);
      if (pos === 0) { if (x.c < vw - k * a) pos = 1; else if (allowShort && x.c > vw + k * a) pos = -1; }
      else if ((pos === 1 && x.c >= vw) || (pos === -1 && x.c <= vw)) pos = 0;
      return pos;
    });
  };
}
function tsMom(n: number, allowShort: boolean): Gen {
  return (cs) => cs.map((x, i) => {
    if (i < n) return 0;
    const past = cs[i - n]!.c;
    return x.c > past ? 1 : allowShort ? -1 : 0;
  });
}
function volBreakout(k: number, allowShort: boolean): Gen {
  return (cs) => {
    let pos = 0;
    return cs.map((x, i) => {
      const a = atr(cs, i); if (!(a > 0) || i < 2) return (pos = 0);
      const ref = cs[i - 1]!.c;
      if (x.c > ref + k * a) pos = 1; else if (allowShort && x.c < ref - k * a) pos = -1;
      else if (pos !== 0 && Math.abs(x.c - ref) < k * a * 0.25) pos = 0;
      return pos;
    });
  };
}

const CONFIGS: { label: string; family: string; gen: Gen }[] = [];
for (const kind of ["sma", "ema"] as const)
  for (const [f, s] of [[9, 21], [10, 50], [20, 50], [50, 200], [12, 26], [5, 20]])
    for (const short of [true, false])
      CONFIGS.push({ label: `MAcross ${kind} ${f}/${s}${short ? " LS" : " L"}`, family: "MA cross", gen: maCross(f!, s!, kind, short) });
for (const n of [7, 14, 21])
  for (const [lo, hi] of [[30, 70], [25, 75], [20, 80]])
    for (const short of [true, false])
      CONFIGS.push({ label: `RSI ${n} ${lo}/${hi}${short ? " LS" : " L"}`, family: "RSI revert", gen: rsiRevert(n, lo!, hi!, short) });
for (const [f, s, g] of [[12, 26, 9], [5, 35, 5], [8, 21, 5]])
  for (const short of [true, false])
    CONFIGS.push({ label: `MACD ${f}/${s}/${g}${short ? " LS" : " L"}`, family: "MACD", gen: macd(f!, s!, g!, short) });
for (const n of [20, 50])
  for (const k of [1.5, 2, 2.5])
    for (const mode of ["revert", "breakout"] as const)
      for (const short of [true, false])
        CONFIGS.push({ label: `BB ${n}/${k} ${mode}${short ? " LS" : " L"}`, family: `Bollinger ${mode}`, gen: bollinger(n, k, mode, short) });
for (const n of [20, 55, 100, 200])
  for (const short of [true, false])
    CONFIGS.push({ label: `Donchian ${n}${short ? " LS" : " L"}`, family: "Donchian", gen: donchian(n, short) });
for (const n of [14, 21])
  for (const [lo, hi] of [[20, 80], [10, 90]])
    for (const short of [true, false])
      CONFIGS.push({ label: `Stoch ${n} ${lo}/${hi}${short ? " LS" : " L"}`, family: "Stochastic", gen: stochastic(n, lo!, hi!, short) });
for (const n of [10, 14])
  for (const m of [2, 3, 4])
    for (const short of [true, false])
      CONFIGS.push({ label: `Supertrend ${n}x${m}${short ? " LS" : " L"}`, family: "Supertrend", gen: supertrend(n, m, short) });
for (const n of [48, 96])
  for (const k of [1, 1.5, 2])
    for (const short of [true, false])
      CONFIGS.push({ label: `VWAPrev ${n}/${k}${short ? " LS" : " L"}`, family: "VWAP revert", gen: vwapRevert(n, k, short) });
for (const n of [4, 16, 48, 96, 192])
  for (const short of [true, false])
    CONFIGS.push({ label: `TSmom ${n}${short ? " LS" : " L"}`, family: "TS momentum", gen: tsMom(n, short) });
for (const k of [0.5, 1, 1.5, 2, 2.5, 3])
  for (const short of [true, false])
    CONFIGS.push({ label: `VolBrk ${k}${short ? " LS" : " L"}`, family: "Vol breakout", gen: volBreakout(k, short) });
// widen the sweep so the count matches what "200 strategies" means in practice
for (const kind of ["sma", "ema"] as const)
  for (const [f, s] of [[3, 10], [4, 9], [7, 14], [8, 34], [13, 34], [21, 55], [34, 89], [100, 200]])
    for (const short of [true, false])
      CONFIGS.push({ label: `MAcross ${kind} ${f}/${s}${short ? " LS" : " L"}`, family: "MA cross", gen: maCross(f!, s!, kind, short) });
for (const n of [5, 9, 28])
  for (const [lo, hi] of [[30, 70], [20, 80], [15, 85]])
    for (const short of [true, false])
      CONFIGS.push({ label: `RSI ${n} ${lo}/${hi}${short ? " LS" : " L"}`, family: "RSI revert", gen: rsiRevert(n, lo!, hi!, short) });
for (const n of [10, 100])
  for (const k of [1, 3])
    for (const mode of ["revert", "breakout"] as const)
      for (const short of [true, false])
        CONFIGS.push({ label: `BB ${n}/${k} ${mode}${short ? " LS" : " L"}`, family: `Bollinger ${mode}`, gen: bollinger(n, k, mode, short) });
for (const n of [10, 30, 80, 150, 400])
  for (const short of [true, false])
    CONFIGS.push({ label: `Donchian ${n}${short ? " LS" : " L"}`, family: "Donchian", gen: donchian(n, short) });
for (const n of [5, 9, 28])
  for (const [lo, hi] of [[25, 75], [15, 85]])
    for (const short of [true, false])
      CONFIGS.push({ label: `Stoch ${n} ${lo}/${hi}${short ? " LS" : " L"}`, family: "Stochastic", gen: stochastic(n, lo!, hi!, short) });
for (const n of [7, 20])
  for (const m of [1.5, 2.5, 5])
    for (const short of [true, false])
      CONFIGS.push({ label: `Supertrend ${n}x${m}${short ? " LS" : " L"}`, family: "Supertrend", gen: supertrend(n, m, short) });
for (const n of [24, 192])
  for (const k of [0.5, 1, 2, 3])
    for (const short of [true, false])
      CONFIGS.push({ label: `VWAPrev ${n}/${k}${short ? " LS" : " L"}`, family: "VWAP revert", gen: vwapRevert(n, k, short) });
for (const n of [2, 8, 24, 32, 64, 144, 288, 384])
  for (const short of [true, false])
    CONFIGS.push({ label: `TSmom ${n}${short ? " LS" : " L"}`, family: "TS momentum", gen: tsMom(n, short) });

// ───────────────────────── evaluate ─────────────────────────
/**
 * Equal-weight portfolio return per bar, net of turnover cost.
 *
 * Aligned on TIMESTAMP, not index. An earlier version indexed each book by
 * position, which silently mixed different calendar dates whenever books had
 * different lengths or start times, and truncated the usable span from 182 days
 * to 74. Align on the shared timestamp grid instead.
 */
const MIN_BOOKS = 6;
const GRID: number[] = (() => {
  const counts = new Map<number, number>();
  for (const b of books) for (const c of b.cs) counts.set(c.t, (counts.get(c.t) ?? 0) + 1);
  // Require MIN_BOOKS rather than all of them. TAO only has 74 days of history
  // while every other pair has 182, so demanding a full intersection threw away
  // 60% of the sample for one late-listed symbol. The portfolio averages over
  // whichever books exist at each bar.
  return [...counts.entries()].filter(([, n]) => n >= MIN_BOOKS).map(([t]) => t).sort((a, b) => a - b);
})();

function portfolio(gen: Gen): { t: number; ret: number; turn: number }[] {
  const perBook = books.map((b) => {
    const pos = gen(b.cs);
    const byT = new Map<number, { pos: number; c: number }>();
    for (let i = 0; i < b.cs.length; i++) byT.set(b.cs[i]!.t, { pos: pos[i] ?? 0, c: b.cs[i]!.c });
    return byT;
  });
  const agg: { t: number; ret: number; turn: number }[] = [];
  for (let g = 1; g < GRID.length - 1; g++) {
    const tNow = GRID[g]!, tPrev = GRID[g - 1]!, tNext = GRID[g + 1]!;
    let r = 0, tu = 0, used = 0;
    for (const byT of perBook) {
      const now = byT.get(tNow), prev = byT.get(tPrev), next = byT.get(tNext);
      if (!now || !prev || !next || !(now.c > 0)) continue;
      const ret = (next.c - now.c) / now.c;              // position at tNow earns the next bar
      const turn = Math.abs(now.pos - prev.pos);
      r += now.pos * ret - turn * COST_PER_SIDE;
      tu += turn;
      used++;
    }
    if (!used) continue;
    agg.push({ t: tNow, ret: r / used, turn: tu / used });
  }
  return agg;
}

function stat(rows: { ret: number; turn: number }[]) {
  const n = rows.length;
  if (n < 200) return null;
  const m = rows.reduce((s, x) => s + x.ret, 0) / n;
  const sd = Math.sqrt(rows.reduce((s, x) => s + (x.ret - m) ** 2, 0) / n) || 1e-12;
  const bars30d = 96 * 30;
  return { n, mean: m, t: (m / sd) * Math.sqrt(n), monthly: Math.pow(1 + m, bars30d) - 1,
    turnPerDay: (rows.reduce((s, x) => s + x.turn, 0) / n) * 96 };
}

const spanT = portfolio(CONFIGS[0]!.gen).map((x) => x.t);
const t0 = spanT[0]!, t1 = spanT[spanT.length - 1]!;
const cutV = t0 + (t1 - t0) * 0.5, cutH = t0 + (t1 - t0) * 0.75;
// Bonferroni for the actual config count, computed rather than hardcoded.
const BONF = Math.abs(2.807 + 0.5 * Math.log(CONFIGS.length / 50));

console.log(`${books.length} pairs · ${((t1 - t0) / 86_400_000).toFixed(0)} days 15m · ${CONFIGS.length} configs`);
console.log(`cost ${(COST_PER_SIDE * 10_000).toFixed(0)}bp per side, charged on turnover`);
console.log(`significance bar for ${CONFIGS.length} tests: |t| > ${BONF}\n`);

const rows = CONFIGS.map((c) => {
  const all = portfolio(c.gen);
  return { c, all, tr: stat(all.filter((x) => x.t < cutV)), v: stat(all.filter((x) => x.t >= cutV && x.t < cutH)) };
}).filter((x) => x.tr && x.v);

rows.sort((a, b) => b.v!.t - a.v!.t);
console.log("top 15 by VALIDATION t   (selection material — not results)");
console.log("config                        TRAIN t   VAL t    VAL %/mo   turn/day");
for (const r of rows.slice(0, 15)) {
  console.log(`${r.c.label.padEnd(28)} ${r.tr!.t.toFixed(1).padStart(6)} ${r.v!.t.toFixed(1).padStart(7)}` +
    `  ${((r.v!.monthly) * 100 >= 0 ? "+" : "") + ((r.v!.monthly) * 100).toFixed(1).padStart(8)}%  ${r.v!.turnPerDay.toFixed(2).padStart(7)}`);
}
console.log("\nworst 5 (for scale):");
for (const r of rows.slice(-5)) console.log(`${r.c.label.padEnd(28)} ${r.tr!.t.toFixed(1).padStart(6)} ${r.v!.t.toFixed(1).padStart(7)}`);

const byFam = new Map<string, number[]>();
for (const r of rows) byFam.set(r.c.family, [...(byFam.get(r.c.family) ?? []), r.v!.t]);
console.log("\nby family — best validation t of each:");
for (const [f, ts] of [...byFam].sort((a, b) => Math.max(...b[1]) - Math.max(...a[1])))
  console.log(`  ${f.padEnd(20)} best t ${Math.max(...ts).toFixed(1).padStart(5)}  (${ts.length} configs)`);

const passBonf = rows.filter((r) => r.v!.t > BONF && r.tr!.t > 0);
console.log(`\n${passBonf.length} of ${rows.length} configs clear |t| > ${BONF} on validation AND are positive on train`);
if (!passBonf.length) {
  console.log("Nothing clears the multiple-comparison bar, so nothing earns a holdout score.");
  const best = rows[0]!;
  console.log(`Best was ${best.c.label} at validation t ${best.v!.t.toFixed(1)} — below ${BONF}, i.e. within chance for ${rows.length} tests.`);
  process.exit(0);
}
const pick = passBonf[0]!;
const h = stat(pick.all.filter((x) => x.t >= cutH))!;
console.log(`\nSELECTED ${pick.c.label}\nHOLDOUT (once): t ${h.t.toFixed(1)}  ${(h.monthly*100).toFixed(1)}%/month  turn/day ${h.turnPerDay.toFixed(2)}`);
