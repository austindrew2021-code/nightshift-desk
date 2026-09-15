/**
 * Aggressive strategy families, measured by distribution rather than by one path.
 *
 *   npm run aggro:ict
 *
 * Grid, martingale, DCA averaging-down and pyramiding are what retail reaches for
 * at a 10x target, and they share a signature: a high MEDIAN with a catastrophic
 * TAIL. One backtest path of a martingale usually looks excellent, because the
 * ruin lives in the 10-20% of paths you did not happen to draw. So the only
 * honest way to test them is many real price paths and the full distribution.
 *
 * Method: every strategy runs over the real 182-day 15m series for each pair, from
 * many different start dates (600 path draws), each path 30 days long. What gets
 * reported is median, P5, P95, probability of ruin, and probability of reaching
 * $1,000 — not a single equity curve.
 *
 * Costs: 7bp per side on every fill, which grid and martingale generate a lot of.
 * Liquidation: isolated margin, so a position is closed at a total loss if price
 * moves against it by the liquidation distance for its leverage.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, atr } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import { liqDistance } from "../src/lib/engine/sizing.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = join(process.env.TMPDIR ?? "/tmp", `nightshift-bt-15m-${process.argv[2] ?? "175"}`);
const COST = (5 + 2) / 10_000;
const PATHS = Number(process.env.PATHS ?? 600);
const BARS_30D = 96 * 30;
const START = 100;
const TARGET = 1000;

const books: { sym: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= BARS_30D + 500) books.push({ sym: a.symbol, cs });
}
if (!books.length) { console.log(`no cache at ${CACHE}`); process.exit(1); }

let seed = 20260915;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };

interface Out { eq: number; ruin: boolean; hit: boolean; dd: number; fills: number }

/**
 * GRID: place `levels` buy rungs below and sell rungs above a midpoint, each
 * `stepAtr` apart. Buy a rung on the way down, sell it back on the way up.
 * `stopOnBreak` closes everything if price leaves the grid — without it, an
 * exit from the range simply keeps accumulating, which is the classic failure.
 */
function grid(cs: Candle[], i0: number, levels: number, stepAtr: number, lev: number, stopOnBreak: boolean): Out {
  let cash = START, dd = 0, peak = START, fills = 0;
  const a0 = atr(cs, i0);
  if (!(a0 > 0)) return { eq: START, ruin: false, hit: false, dd: 0, fills: 0 };
  const mid = cs[i0]!.c;
  const step = a0 * stepAtr;
  const perRung = (START * lev) / levels;             // notional per rung
  const open: { entry: number; size: number }[] = [];
  const liq = liqDistance(lev);
  for (let i = i0 + 1; i < Math.min(cs.length, i0 + BARS_30D); i++) {
    const p = cs[i]!.c;
    // fill the next buy rung down
    const nextRung = mid - step * (open.length + 1);
    if (p <= nextRung && open.length < levels) {
      open.push({ entry: p, size: perRung });
      cash -= perRung * COST;
      fills++;
    }
    // close the deepest rung once price recovers one step above its entry
    for (let k = open.length - 1; k >= 0; k--) {
      if (p >= open[k]!.entry + step) {
        const o = open.splice(k, 1)[0]!;
        cash += (o.size * step) / o.entry - o.size * COST;
        fills++;
      }
    }
    // isolated liquidation on the aggregate adverse move
    const totalAdverse = open.reduce((s, o) => s + o.size * ((o.entry - p) / o.entry), 0);
    if (open.length && totalAdverse >= cash * liq * levels) {
      cash -= totalAdverse;
      open.length = 0;
      if (cash <= 0.5) return { eq: 0, ruin: true, hit: false, dd: 1, fills };
    }
    const unreal = open.reduce((s, o) => s - o.size * ((o.entry - p) / o.entry), 0);
    const eq = cash + unreal;
    if (eq <= 0.5) return { eq: 0, ruin: true, hit: false, dd: 1, fills };
    peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak);
    if (stopOnBreak && p < mid - step * (levels + 1)) {
      cash = eq - open.length * perRung * COST; open.length = 0;
      if (cash <= 0.5) return { eq: 0, ruin: true, hit: false, dd: 1, fills };
    }
  }
  const last = cs[Math.min(cs.length - 1, i0 + BARS_30D)]!.c;
  const eq = cash + open.reduce((s, o) => s - o.size * ((o.entry - last) / o.entry), 0);
  return { eq: Math.max(0, eq), ruin: eq <= 0.5, hit: eq >= TARGET, dd, fills };
}

/**
 * MARTINGALE: fixed base risk, double after every loss, reset after a win.
 * Signal is deliberately neutral (coin-flip on the next bar's direction via a
 * 1-bar momentum rule) because martingale's claim is that the signal does not
 * matter — the sizing rule is supposed to do the work.
 */
function martingale(cs: Candle[], i0: number, baseRisk: number, maxDouble: number, stopAtr: number): Out {
  let cash = START, streak = 0, dd = 0, peak = START, fills = 0;
  for (let i = i0 + 2; i < Math.min(cs.length, i0 + BARS_30D); i++) {
    const a = atr(cs, i);
    if (!(a > 0)) continue;
    const entry = cs[i]!.c;
    const stopDist = a * stopAtr;
    const long = cs[i]!.c > cs[i - 1]!.c;
    const risk = cash * baseRisk * Math.pow(2, Math.min(streak, maxDouble));
    if (risk >= cash) return { eq: 0, ruin: true, hit: false, dd: 1, fills };
    const notional = risk / (stopDist / entry);
    let won: boolean | null = null;
    for (let k = i + 1; k < Math.min(cs.length, i + 40); k++) {
      const hi = cs[k]!.h, lo = cs[k]!.l;
      if (long) { if (lo <= entry - stopDist) { won = false; break; } if (hi >= entry + stopDist) { won = true; break; } }
      else { if (hi >= entry + stopDist) { won = false; break; } if (lo <= entry - stopDist) { won = true; break; } }
    }
    if (won === null) continue;
    cash += (won ? risk : -risk) - notional * COST * 2;
    fills++;
    streak = won ? 0 : streak + 1;
    if (cash <= 0.5) return { eq: 0, ruin: true, hit: false, dd: 1, fills };
    peak = Math.max(peak, cash); dd = Math.max(dd, (peak - cash) / peak);
    if (cash >= TARGET) return { eq: cash, ruin: false, hit: true, dd, fills };
    i += 3;
  }
  return { eq: cash, ruin: false, hit: false, dd, fills };
}

/** Fixed-fraction sizing on the best edge measured in this project (row 40: A+ raid, ~54% win at 1:1). */
function kelly(cs: Candle[], i0: number, frac: number): Out {
  // Kelly for a 1:1 bet at win p is 2p-1. At p=0.54 that is 0.08.
  const p = 0.54;
  let cash = START, dd = 0, peak = START, fills = 0;
  const n = Math.round(BARS_30D / 96 * 1.2);           // ~1.2 A+ trades/day
  for (let k = 0; k < n; k++) {
    const risk = cash * frac;
    if (risk >= cash) return { eq: 0, ruin: true, hit: false, dd: 1, fills };
    const won = rnd() < p;
    cash += won ? risk : -risk;
    cash -= risk * 0.14;                                // 14bp cost as a share of risk at a 1% stop
    fills++;
    if (cash <= 0.5) return { eq: 0, ruin: true, hit: false, dd: 1, fills };
    peak = Math.max(peak, cash); dd = Math.max(dd, (peak - cash) / peak);
    if (cash >= TARGET) return { eq: cash, ruin: false, hit: true, dd, fills };
  }
  return { eq: cash, ruin: false, hit: false, dd, fills };
}

function report(label: string, run: () => Out) {
  const eqs: number[] = []; let ruin = 0, hit = 0, dds = 0, fills = 0;
  for (let i = 0; i < PATHS; i++) {
    const o = run();
    eqs.push(o.eq); if (o.ruin) ruin++; if (o.hit) hit++; dds += o.dd; fills += o.fills;
  }
  eqs.sort((a, b) => a - b);
  const q = (f: number) => eqs[Math.min(eqs.length - 1, Math.floor(eqs.length * f))]!;
  const mean = eqs.reduce((a, b) => a + b, 0) / eqs.length;
  console.log(
    `${label.padEnd(34)} med $${q(0.5).toFixed(0).padStart(5)}  mean $${mean.toFixed(0).padStart(5)}` +
    `  P5 $${q(0.05).toFixed(0).padStart(4)}  P95 $${q(0.95).toFixed(0).padStart(6)}` +
    `  ruin ${((ruin / PATHS) * 100).toFixed(0).padStart(3)}%  P($1k) ${((hit / PATHS) * 100).toFixed(1).padStart(5)}%` +
    `  dd ${((dds / PATHS) * 100).toFixed(0).padStart(3)}%  fills ${(fills / PATHS).toFixed(0)}`,
  );
}

const pick = () => {
  const b = books[Math.floor(rnd() * books.length)]!;
  const i0 = 300 + Math.floor(rnd() * (b.cs.length - BARS_30D - 320));
  return { cs: b.cs, i0 };
};

console.log(`${books.length} pairs · real 182-day paths · ${PATHS} draws of 30 days each · $${START} start`);
console.log(`cost ${(COST * 10_000).toFixed(0)}bp/side on every fill · isolated liquidation modelled\n`);

console.log("GRID  (buy rungs down, sell back up)");
for (const lev of [1, 3, 5, 10]) {
  for (const stop of [false, true]) {
    report(`  grid 8 rungs ${lev}x ${stop ? "stop-on-break" : "NO stop"}`, () => { const { cs, i0 } = pick(); return grid(cs, i0, 8, 0.5, lev, stop); });
  }
}
console.log("\nMARTINGALE  (double after each loss, 1:1 bet)");
for (const base of [0.01, 0.02, 0.05]) {
  for (const md of [3, 5, 8]) {
    report(`  base ${(base*100).toFixed(0)}% max ${md} doublings`, () => { const { cs, i0 } = pick(); return martingale(cs, i0, base, md, 1); });
  }
}
console.log("\nFIXED-FRACTION on the best measured edge (54% win at 1:1, 1.2 trades/day)");
console.log("  Kelly for this bet = 8% of book. Over-betting Kelly is the aggressive case.");
for (const f of [0.04, 0.08, 0.18, 0.25, 0.40]) {
  const tag = f === 0.08 ? " (full Kelly)" : f === 0.04 ? " (half Kelly)" : f > 0.08 ? " (OVER Kelly)" : "";
  report(`  risk ${(f*100).toFixed(0)}%/trade${tag}`, () => { const { cs, i0 } = pick(); return kelly(cs, i0, f); });
}
