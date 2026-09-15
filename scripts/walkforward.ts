/**
 * Rolling walk-forward over three years, and a full ranking.
 *
 *   npm run wf:ict
 *
 * Every previous test here used ONE train/validation/holdout split on 182 days.
 * That answers "was there an edge in this window". A rolling walk-forward answers
 * the question that actually matters: re-fit periodically, always trade forward,
 * and see what the chained out-of-sample record looks like.
 *
 *   fold 1: fit on days    0-360, trade days  360-450
 *   fold 2: fit on days   90-450, trade days  450-540
 *   ... step 90 days, ~8 folds over 1,125 days
 *
 * Two outputs:
 *  1. SELECTED-EACH-FOLD — pick the best config on each training window and trade
 *     it forward. This is the realistic record of running this process, including
 *     the cost of selection being wrong.
 *  2. RANKING — every config's MEAN out-of-sample result across all folds. A
 *     config positive in 7 of 8 independent forward windows is a far stronger
 *     claim than one that won a single holdout.
 *
 * Data: 1H bars, 1,125 days (Aug 2023 - Sep 2026), which spans several regimes
 * rather than one grind. 7bp per side charged on turnover.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines } from "../src/lib/engine/ict.ts";
import {
  maCross, rsiRevert, macd, bollinger, donchian, stochastic,
  supertrend, vwapRevert, tsMom, volBreakout, regimeSwitch, type Gen,
} from "../src/lib/engine/signals.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = "/tmp/nightshift-1h-3y";
const COST = (5 + 2) / 10_000;
const BARS_DAY = 24;
const TRAIN_D = 360, TEST_D = 90, STEP_D = 90;
const MIN_BOOKS = 5;

const books: { sym: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 8000) books.push({ sym: a.symbol, cs });   // exclude new listings
}
if (books.length < MIN_BOOKS) { console.log(`need >=${MIN_BOOKS} books, have ${books.length}`); process.exit(1); }

// ── shared hourly grid ──
const GRID: number[] = (() => {
  const counts = new Map<number, number>();
  for (const b of books) for (const c of b.cs) counts.set(c.t, (counts.get(c.t) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= MIN_BOOKS).map(([t]) => t).sort((a, b) => a - b);
})();

/** Per-bar equal-weight portfolio return, net of turnover. Computed once per config. */
function series(gen: Gen): { t: number; ret: number; turn: number }[] {
  const per = books.map((b) => {
    const pos = gen(b.cs);
    const m = new Map<number, { p: number; c: number }>();
    for (let i = 0; i < b.cs.length; i++) m.set(b.cs[i]!.t, { p: pos[i] ?? 0, c: b.cs[i]!.c });
    return m;
  });
  const out: { t: number; ret: number; turn: number }[] = [];
  for (let g = 1; g < GRID.length - 1; g++) {
    const tN = GRID[g]!, tP = GRID[g - 1]!, tX = GRID[g + 1]!;
    let r = 0, tu = 0, used = 0;
    for (const m of per) {
      const now = m.get(tN), prev = m.get(tP), next = m.get(tX);
      if (!now || !prev || !next || !(now.c > 0)) continue;
      const turn = Math.abs(now.p - prev.p);
      r += now.p * ((next.c - now.c) / now.c) - turn * COST;
      tu += turn; used++;
    }
    if (used) out.push({ t: tN, ret: r / used, turn: tu / used });
  }
  return out;
}

function stat(rows: { ret: number }[]) {
  const n = rows.length;
  if (n < 100) return null;
  const m = rows.reduce((s, x) => s + x.ret, 0) / n;
  const sd = Math.sqrt(rows.reduce((s, x) => s + (x.ret - m) ** 2, 0) / n) || 1e-12;
  return { n, mean: m, t: (m / sd) * Math.sqrt(n), monthly: Math.pow(1 + m, BARS_DAY * 30) - 1,
    sharpe: (m / sd) * Math.sqrt(BARS_DAY * 365) };
}

// ── config set (periods in HOURS now, not 15m bars) ──
const CONFIGS: { label: string; family: string; gen: Gen }[] = [];
for (const kind of ["sma", "ema"] as const)
  for (const [f, s] of [[5, 20], [9, 21], [10, 50], [20, 50], [50, 200], [12, 26], [21, 55], [34, 89]])
    for (const short of [true, false])
      CONFIGS.push({ label: `MAcross ${kind} ${f}/${s}${short ? " LS" : " L"}`, family: "MA cross", gen: maCross(f!, s!, kind, short) });
for (const n of [7, 14, 21, 28])
  for (const [lo, hi] of [[30, 70], [25, 75], [20, 80]])
    for (const short of [true, false])
      CONFIGS.push({ label: `RSI ${n} ${lo}/${hi}${short ? " LS" : " L"}`, family: "RSI revert", gen: rsiRevert(n, lo!, hi!, short) });
for (const [f, s, g] of [[12, 26, 9], [8, 21, 5], [5, 35, 5]])
  for (const short of [true, false])
    CONFIGS.push({ label: `MACD ${f}/${s}/${g}${short ? " LS" : " L"}`, family: "MACD", gen: macd(f!, s!, g!, short) });
for (const n of [20, 50, 100])
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
for (const n of [10, 14, 20])
  for (const m of [2, 3, 4])
    for (const short of [true, false])
      CONFIGS.push({ label: `Supertrend ${n}x${m}${short ? " LS" : " L"}`, family: "Supertrend", gen: supertrend(n, m, short) });
for (const n of [24, 48, 168])
  for (const k of [1, 1.5, 2])
    for (const short of [true, false])
      CONFIGS.push({ label: `VWAPrev ${n}/${k}${short ? " LS" : " L"}`, family: "VWAP revert", gen: vwapRevert(n, k, short) });
for (const n of [6, 12, 24, 72, 168, 336])
  for (const short of [true, false])
    CONFIGS.push({ label: `TSmom ${n}h${short ? " LS" : " L"}`, family: "TS momentum", gen: tsMom(n, short) });
for (const k of [0.5, 1, 1.5, 2])
  for (const short of [true, false])
    CONFIGS.push({ label: `VolBrk ${k}${short ? " LS" : " L"}`, family: "Vol breakout", gen: volBreakout(k, short) });
for (const hn of [168, 336])
  for (const [lo, hi] of [[0.45, 0.55], [0.4, 0.6]])
    CONFIGS.push({ label: `Regime H${hn} ${lo}/${hi}`, family: "Hurst regime",
      gen: regimeSwitch(hn, lo!, hi!, rsiRevert(14, 30, 70, true), donchian(55, true)) });

const t0 = GRID[0]!, t1 = GRID[GRID.length - 1]!;
const spanD = (t1 - t0) / 86_400_000;
console.log(`${books.length} pairs · 1H · ${spanD.toFixed(0)} days (${(spanD/365).toFixed(2)}y) · ${CONFIGS.length} configs`);
console.log(`walk-forward: fit ${TRAIN_D}d -> trade ${TEST_D}d, step ${STEP_D}d · cost ${(COST*10_000).toFixed(0)}bp/side\n`);

// Precompute every config's full series once.
const all = CONFIGS.map((c) => ({ c, s: series(c.gen) }));

// ── folds ──
const folds: { fit: [number, number]; test: [number, number] }[] = [];
for (let d = TRAIN_D; d + TEST_D <= spanD; d += STEP_D) {
  folds.push({
    fit: [t0 + (d - TRAIN_D) * 86_400_000, t0 + d * 86_400_000],
    test: [t0 + d * 86_400_000, t0 + (d + TEST_D) * 86_400_000],
  });
}
console.log(`${folds.length} folds\n`);

// 1. SELECTED-EACH-FOLD
const chained: { ret: number }[] = [];
const picks: string[] = [];
for (const f of folds) {
  let best: { label: string; t: number } | null = null;
  for (const a of all) {
    const s = stat(a.s.filter((x) => x.t >= f.fit[0] && x.t < f.fit[1]));
    if (s && (!best || s.t > best.t)) best = { label: a.c.label, t: s.t };
  }
  if (!best) continue;
  const chosen = all.find((a) => a.c.label === best!.label)!;
  const oos = chosen.s.filter((x) => x.t >= f.test[0] && x.t < f.test[1]);
  chained.push(...oos);
  const os = stat(oos);
  picks.push(`${new Date(f.test[0]).toISOString().slice(0, 7)}  ${best.label.padEnd(26)} fitT ${best.t.toFixed(1).padStart(5)}  OOS ${os ? ((os.monthly*100>=0?"+":"")+(os.monthly*100).toFixed(1)).padStart(7) + "%/mo" : "  n/a"}`);
}
console.log("SELECTED-EACH-FOLD — best on each training window, traded forward");
for (const p of picks) console.log("  " + p);
const ch = stat(chained);
if (ch) {
  let eq = 100; for (const x of chained) eq *= 1 + x.ret;
  console.log(`\n  chained out-of-sample: ${(ch.monthly*100>=0?"+":"")}${(ch.monthly*100).toFixed(2)}%/month  t ${ch.t.toFixed(2)}  Sharpe ${ch.sharpe.toFixed(2)}`);
  console.log(`  $100 -> $${eq.toFixed(2)} over ${(chained.length / BARS_DAY).toFixed(0)} days of forward trading`);
}

// 2. RANKING by mean OOS across folds
console.log(`\nRANKING — every config by its performance across all ${folds.length} forward windows`);
const ranked = all.map((a) => {
  const perFold = folds.map((f) => stat(a.s.filter((x) => x.t >= f.test[0] && x.t < f.test[1]))).filter(Boolean) as NonNullable<ReturnType<typeof stat>>[];
  if (perFold.length < folds.length - 1) return null;
  const means = perFold.map((p) => p.mean);
  const m = means.reduce((s, x) => s + x, 0) / means.length;
  const sd = Math.sqrt(means.reduce((s, x) => s + (x - m) ** 2, 0) / means.length) || 1e-12;
  const posFolds = means.filter((x) => x > 0).length;
  const oosAll = stat(folds.flatMap((f) => a.s.filter((x) => x.t >= f.test[0] && x.t < f.test[1])))!;
  return { label: a.c.label, family: a.c.family, monthly: oosAll.monthly, t: oosAll.t,
    sharpe: oosAll.sharpe, posFolds, folds: means.length, consistency: (m / sd) * Math.sqrt(means.length) };
}).filter(Boolean) as NonNullable<ReturnType<typeof stat>> extends never ? never[] : { label: string; family: string; monthly: number; t: number; sharpe: number; posFolds: number; folds: number; consistency: number }[];

ranked.sort((a, b) => b.t - a.t);
console.log("rank  config                       OOS %/mo   t     Sharpe  folds+  consistency");
for (const [i, r] of ranked.slice(0, 20).entries())
  console.log(`${String(i+1).padStart(4)}  ${r.label.padEnd(27)} ${((r.monthly*100>=0?"+":"")+(r.monthly*100).toFixed(2)).padStart(8)}% ${r.t.toFixed(2).padStart(6)} ${r.sharpe.toFixed(2).padStart(7)}  ${r.posFolds}/${r.folds}    ${r.consistency.toFixed(2)}`);
console.log("  ...");
for (const [i, r] of ranked.slice(-5).entries())
  console.log(`${String(ranked.length-4+i).padStart(4)}  ${r.label.padEnd(27)} ${((r.monthly*100>=0?"+":"")+(r.monthly*100).toFixed(2)).padStart(8)}% ${r.t.toFixed(2).padStart(6)} ${r.sharpe.toFixed(2).padStart(7)}  ${r.posFolds}/${r.folds}    ${r.consistency.toFixed(2)}`);

// ── the benchmark that decides alpha vs beta ──
// Nearly every top-ranked config is long-only ("L") over a period when crypto
// rose a lot, so the real question is not "did it make money" but "did it beat
// simply holding". Always-long is the zero-skill baseline.
const alwaysLong: Gen = (cs) => cs.map(() => 1);
const bh = series(alwaysLong);
const bhOos = stat(folds.flatMap((f) => bh.filter((x) => x.t >= f.test[0] && x.t < f.test[1])));
if (bhOos) {
  let eq = 100;
  for (const f of folds) for (const x of bh.filter((y) => y.t >= f.test[0] && y.t < f.test[1])) eq *= 1 + x.ret;
  console.log(`\nBENCHMARK — equal-weight BUY AND HOLD over the same forward windows`);
  console.log(`  ${(bhOos.monthly*100>=0?"+":"")}${(bhOos.monthly*100).toFixed(2)}%/month  t ${bhOos.t.toFixed(2)}  Sharpe ${bhOos.sharpe.toFixed(2)}  $100 -> $${eq.toFixed(2)}`);
  const beat = ranked.filter((r) => r.monthly > bhOos.monthly);
  console.log(`  ${beat.length} of ${ranked.length} configs beat buy-and-hold on monthly return`);
  console.log(`  best-ranked config (${ranked[0]!.label}) at ${(ranked[0]!.monthly*100).toFixed(2)}%/mo` +
    ` vs hold at ${(bhOos.monthly*100).toFixed(2)}%/mo -> ${ranked[0]!.monthly > bhOos.monthly ? "BEATS" : "LOSES TO"} holding`);
  if (ch) console.log(`  selected-each-fold (${(ch.monthly*100).toFixed(2)}%/mo) vs hold -> ${ch.monthly > bhOos.monthly ? "BEATS" : "LOSES TO"} holding`);
}

const BONF = 2.807 + 0.5 * Math.log(ranked.length / 50);
const winners = ranked.filter((r) => r.t > BONF && r.posFolds >= r.folds - 1);
console.log(`\nbar for ${ranked.length} configs: OOS t > ${BONF.toFixed(2)} AND positive in >= ${folds.length - 1}/${folds.length} folds`);
console.log(`${winners.length} config(s) clear it${winners.length ? ": " + winners.map((w) => w.label).join(", ") : ""}`);
const byFam = new Map<string, number>();
for (const r of ranked) byFam.set(r.family, Math.max(byFam.get(r.family) ?? -99, r.t));
console.log("\nbest OOS t by family:");
for (const [f, tv] of [...byFam].sort((a, b) => b[1] - a[1])) console.log(`  ${f.padEnd(20)} ${tv.toFixed(2).padStart(6)}`);
