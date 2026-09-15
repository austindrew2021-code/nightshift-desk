/**
 * Cross-sectional (relative-value) strategies across the universe.
 *
 *   npm run xs:ict
 *
 * Structurally different from everything tested so far. Instead of asking "is
 * this coin going up", it ranks all pairs against each other and goes long the
 * bottom / short the top (reversal) or the reverse (momentum). Properties that
 * matter here:
 *
 *  - Dollar-neutral, so a market-wide dump is not automatically a loss. Every
 *    prior test was directional and died in flushes.
 *  - Frequency is a choice (the rebalance period), not a property of a rare
 *    setup. Board row 43 showed the goal needs >=10 trades/day at >=+0.10R, which
 *    a selective setup can never supply.
 *  - Cross-sectional momentum is the most documented anomaly in the crypto
 *    literature, so it is a prior worth testing rather than an invention.
 *
 * Three-way split: train 50% to develop, validation 25% to choose, holdout 25%
 * scored once for the chosen config only. Costs charged per leg, both sides.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = join(process.env.TMPDIR ?? "/tmp", `nightshift-bt-15m-${process.argv[2] ?? "175"}`);
const FEE_BP = 5, SLIP_BP = 2;
const COST_BP_PER_LEG = (FEE_BP + SLIP_BP) * 2;   // in and out

const books: { sym: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 500) books.push({ sym: a.symbol, cs });
}
if (books.length < 6) { console.log(`need >=6 books, have ${books.length}`); process.exit(1); }

/** Align every book onto a shared 15m timestamp grid so ranks are comparable. */
const common = books.reduce<number[]>((acc, b, idx) => {
  const ts = b.cs.map((c) => c.t);
  if (idx === 0) return ts;
  const set = new Set(ts);
  return acc.filter((t) => set.has(t));
}, []);
common.sort((a, b) => a - b);
const px: Record<string, Map<number, number>> = {};
for (const b of books) px[b.sym] = new Map(b.cs.map((c) => [c.t, c.c]));
const syms = books.map((b) => b.sym);

interface Leg { t: number; ret: number }

/**
 * One backtest. Every `holdBars`, rank pairs by return over `lookBars`, take the
 * `k` extremes on each side, hold for `holdBars`, then rebalance.
 * `dir` = +1 momentum (long winners), -1 reversal (long losers).
 */
function run(lookBars: number, holdBars: number, k: number, dir: 1 | -1): Leg[] {
  const out: Leg[] = [];
  for (let i = lookBars; i + holdBars < common.length; i += holdBars) {
    const t0 = common[i]!, t1 = common[i + holdBars]!, tPast = common[i - lookBars]!;
    const scored: { sym: string; past: number }[] = [];
    for (const s of syms) {
      const a = px[s]!.get(tPast), b = px[s]!.get(t0);
      if (!a || !b || a <= 0) continue;
      scored.push({ sym: s, past: (b - a) / a });
    }
    if (scored.length < 6) continue;
    scored.sort((a, b) => a.past - b.past);
    const losers = scored.slice(0, k), winners = scored.slice(-k);
    const fwd = (s: string) => {
      const a = px[s]!.get(t0), b = px[s]!.get(t1);
      return a && b && a > 0 ? (b - a) / a : null;
    };
    const longs = dir === 1 ? winners : losers;
    const shorts = dir === 1 ? losers : winners;
    const lr = longs.map((x) => fwd(x.sym)).filter((v): v is number => v !== null);
    const sr = shorts.map((x) => fwd(x.sym)).filter((v): v is number => v !== null);
    if (!lr.length || !sr.length) continue;
    const gross = lr.reduce((a, b) => a + b, 0) / lr.length - sr.reduce((a, b) => a + b, 0) / sr.length;
    // Both sides turn over every rebalance: cost applies to the whole book.
    const net = gross - COST_BP_PER_LEG / 10_000;
    out.push({ t: t0, ret: net });
  }
  return out;
}

function stat(rows: Leg[]) {
  const n = rows.length;
  if (n < 20) return null;
  const m = rows.reduce((s, x) => s + x.ret, 0) / n;
  const sd = Math.sqrt(rows.reduce((s, x) => s + (x.ret - m) ** 2, 0) / n) || 1e-9;
  return { n, mean: m, t: (m / sd) * Math.sqrt(n), win: rows.filter((x) => x.ret > 0).length / n, sd };
}

const t0 = common[0]!, t1 = common[common.length - 1]!;
const cutV = t0 + (t1 - t0) * 0.5, cutH = t0 + (t1 - t0) * 0.75;
const days = (t1 - t0) / 86_400_000;

console.log(`${books.length} pairs · ${common.length} aligned 15m bars · ${days.toFixed(0)} days`);
console.log(`cost ${COST_BP_PER_LEG}bp of book per rebalance (both legs, in and out)`);
console.log(`train <50% · validation 50-75% · holdout last 25%\n`);

const BARS = { "1h": 4, "4h": 16, "12h": 48, "1d": 96 };
const configs: { label: string; look: number; hold: number; k: number; dir: 1 | -1 }[] = [];
for (const [ll, lb] of Object.entries(BARS)) {
  for (const [hl, hb] of Object.entries(BARS)) {
    for (const k of [2, 3]) {
      for (const dir of [1, -1] as const) {
        configs.push({ label: `${dir === 1 ? "MOM" : "REV"} look ${ll} hold ${hl} k${k}`, look: lb, hold: hb, k, dir });
      }
    }
  }
}

const scored = configs.map((c) => {
  const all = run(c.look, c.hold, c.k, c.dir);
  return { c, all, tr: stat(all.filter((x) => x.t < cutV)), v: stat(all.filter((x) => x.t >= cutV && x.t < cutH)) };
}).filter((x) => x.tr && x.v);

scored.sort((a, b) => b.v!.t - a.v!.t);
console.log("top 12 by VALIDATION t  (selection material, not a result)");
console.log("config                        TRAIN            VALIDATION");
console.log("                               n   mean%    t     n   mean%    t");
for (const s of scored.slice(0, 12)) {
  const f = (x: NonNullable<typeof s.tr>) =>
    `${String(x.n).padStart(4)} ${(x.mean * 100 >= 0 ? "+" : "") + (x.mean * 100).toFixed(3)} ${x.t.toFixed(1).padStart(5)}`;
  console.log(`${s.c.label.padEnd(28)} ${f(s.tr!)}  ${f(s.v!)}`);
}

// Fixed selection rule: best validation t among configs also positive on train.
const eligible = scored.filter((s) => s.v!.mean > 0 && s.tr!.mean > 0 && s.v!.n >= 40);
console.log(`\n${eligible.length} of ${scored.length} configs are positive on BOTH train and validation`);
if (!eligible.length) {
  console.log("Nothing qualifies, so there is nothing to score on the holdout.");
  process.exit(0);
}
const pick = eligible[0]!;
console.log(`\nSELECTED: ${pick.c.label}  (val mean ${(pick.v!.mean*100).toFixed(3)}%/rebalance, t ${pick.v!.t.toFixed(1)})`);

const hold = pick.all.filter((x) => x.t >= cutH);
const h = stat(hold);
if (!h) { console.log("holdout too thin"); process.exit(0); }
const holdDays = (t1 - cutH) / 86_400_000;
const perDay = h.n / holdDays;
console.log(`\nHOLDOUT — scored once:`);
console.log(`  n=${h.n} rebalances over ${holdDays.toFixed(0)} days (${perDay.toFixed(1)}/day)`);
console.log(`  mean ${(h.mean*100 >= 0 ? "+" : "") + (h.mean*100).toFixed(4)}% per rebalance   t ${h.t.toFixed(1)}   win ${(h.win*100).toFixed(0)}%`);
console.log(`\n  $100 compounded at full book, no leverage:`);
let eq = 100; for (const x of hold) eq *= 1 + x.ret;
console.log(`    -> $${eq.toFixed(2)} over ${holdDays.toFixed(0)} days`);
for (const lev of [1, 2, 3, 5]) {
  let e = 100, peak = 100, dd = 0, blew = false;
  for (const x of hold) { e *= 1 + x.ret * lev; if (e <= 0.5) { blew = true; break; } peak = Math.max(peak, e); dd = Math.max(dd, (peak - e) / peak); }
  const monthly = blew ? 0 : Math.pow(e / 100, 30 / holdDays);
  console.log(`    ${lev}x book -> $${blew ? "0 RUIN" : e.toFixed(2)}  maxDD ${(dd*100).toFixed(0)}%  ${blew ? "" : `${monthly.toFixed(2)}x/month`}`);
}
console.log(`\n  t below ~2 means not distinguishable from zero on this sample.`);
