/**
 * The weekly-low wick reversal, as an actual tradeable strategy.
 *
 *   npm run wick:ict
 *
 * From scripts/reversal.ts: sweeping the prior week's low on a bar that closes
 * with a long LOWER WICK is followed by excess return over baseline within 24h,
 * stable across train / validation / holdout (+0.62% / +0.64% / +0.83%) at t 5.4,
 * clearing a 378-test Bonferroni bar.
 *
 * That was a measurement of the phenomenon. This is the trade: entry, hold, exit,
 * costs, position sizing across concurrent signals, compounding, and a
 * walk-forward. Excess return over a baseline is not the same as money.
 *
 * Why a long lower wick after a weekly-low sweep should mean something: the sweep
 * runs resting stops below an obvious level, the wick is the signature of that
 * supply being absorbed within the bar rather than followed, and the weekly level
 * is watched widely enough to concentrate both the stops and the response. The
 * same conditioner on a DAILY low is much weaker (t 3.0-3.6), which fits — a daily
 * low holds less resting liquidity.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, atr, rsiWilder } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = "/tmp/nightshift-1h-3y";
const COST_BP = Number(process.env.COST_BP ?? 14);   // round trip
const HOLD = Number(process.env.HOLD ?? 24);
const WICK = Number(process.env.WICK ?? 0.4);

const books: { sym: string; cs: Candle[]; rsi: number[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 8000) books.push({ sym: a.symbol, cs, rsi: rsiWilder(cs, 14) });
}
if (!books.length) { console.log(`no cache at ${CACHE}`); process.exit(1); }

interface Sig { t: number; sym: string; entry: number; exitT: number; ret: number; rsi: number; vol: number }

function signals(b: { sym: string; cs: Candle[]; rsi: number[] }, wick: number, hold: number): Sig[] {
  const cs = b.cs, out: Sig[] = [];
  // prior-week low = rolling min of the 168 bars BEFORE this one
  const pwl = new Array<number>(cs.length).fill(NaN);
  for (let i = 168; i < cs.length; i++) {
    let v = Infinity;
    for (let k = i - 168; k < i; k++) v = Math.min(v, cs[k]!.l);
    pwl[i] = v;
  }
  for (let i = 200; i < cs.length - hold; i++) {
    const c = cs[i]!, lvl = pwl[i]!;
    if (!isFinite(lvl)) continue;
    if (c.l > lvl) continue;                       // must sweep
    if (cs[i - 1]!.l <= pwl[i - 1]!) continue;     // first touch only
    const rng = Math.max(1e-9, c.h - c.l);
    const lower = (Math.min(c.o, c.c) - c.l) / rng;
    if (lower < wick) continue;                    // the conditioner
    const a = atr(cs, i);
    if (!(a > 0)) continue;
    const vol20 = cs.slice(i - 20, i).reduce((s, x) => s + (x.v || 0), 0) / 20;
    out.push({
      t: c.t, sym: b.sym, entry: c.c, exitT: cs[i + hold]!.t,
      ret: (cs[i + hold]!.c - c.c) / c.c,
      rsi: b.rsi[i] ?? 50, vol: vol20 > 0 ? (c.v || 0) / vol20 : 1,
    });
  }
  return out;
}

const all: Sig[] = [];
for (const b of books) all.push(...signals(b, WICK, HOLD));
all.sort((a, b) => a.t - b.t);
const t0 = all[0]!.t, t1 = all[all.length - 1]!.t;
const days = (t1 - t0) / 86_400_000;
const cutV = t0 + (t1 - t0) * 0.5, cutH = t0 + (t1 - t0) * 0.75;

function stat(s: Sig[]) {
  const n = s.length;
  if (n < 30) return null;
  const net = s.map((x) => x.ret - COST_BP / 10_000);
  const m = net.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(net.reduce((a, b) => a + (b - m) ** 2, 0) / n) || 1e-12;
  return { n, mean: m, gross: s.reduce((a, b) => a + b.ret, 0) / n,
    win: net.filter((x) => x > 0).length / n, t: (m / sd) * Math.sqrt(n) };
}

/**
 * Portfolio: equal-weight across whatever is open, capped at `maxOpen`, each
 * position `frac` of book. Compounds. This is the number that matters.
 */
function book(s: Sig[], frac: number, maxOpen: number) {
  const open: { exitT: number; ret: number; size: number }[] = [];
  let cash = 100, peak = 100, dd = 0, taken = 0;
  const evs = [...s].sort((a, b) => a.t - b.t);
  for (const sig of evs) {
    while (open.length && open[0]!.exitT <= sig.t) {
      const o = open.shift()!;
      cash += o.size * (o.ret - COST_BP / 10_000);
      peak = Math.max(peak, cash); dd = Math.max(dd, (peak - cash) / peak);
    }
    if (open.length >= maxOpen) continue;
    open.push({ exitT: sig.exitT, ret: sig.ret, size: cash * frac });
    open.sort((a, b) => a.exitT - b.exitT);
    taken++;
  }
  for (const o of open) cash += o.size * (o.ret - COST_BP / 10_000);
  return { eq: cash, dd, taken, monthly: Math.pow(cash / 100, 30 / days) - 1 };
}

console.log(`weekly-low sweep + lower wick >= ${(WICK*100).toFixed(0)}% · hold ${HOLD}h · ${COST_BP}bp round trip`);
console.log(`${books.length} pairs · ${days.toFixed(0)} days · ${all.length} signals (${(all.length/days*30).toFixed(1)}/month)\n`);

console.log("split        n    gross    net     win      t");
for (const [lbl, sel] of [["train", all.filter((x) => x.t < cutV)],
                          ["validation", all.filter((x) => x.t >= cutV && x.t < cutH)],
                          ["HOLDOUT", all.filter((x) => x.t >= cutH)],
                          ["all", all]] as const) {
  const s = stat(sel);
  if (!s) { console.log(`${lbl.padEnd(12)} too few`); continue; }
  console.log(`${lbl.padEnd(12)}${String(s.n).padStart(4)} ${(s.gross*100>=0?"+":"")+(s.gross*100).toFixed(3)}% ${(s.mean*100>=0?"+":"")+(s.mean*100).toFixed(3)}%  ${(s.win*100).toFixed(0)}%  ${s.t.toFixed(1).padStart(5)}`);
}

console.log(`\nPORTFOLIO — compounding, ${COST_BP}bp, equal-weight concurrent positions`);
console.log(`  NOTE: frac is per POSITION, so frac x maxOpen is GROSS EXPOSURE.`);
console.log(`  100% x 5 open = 5x leveraged, not unlevered. Read the lev column.`);
console.log("  frac  maxOpen   lev    $100 ->   %/month   maxDD   trades");
for (const frac of [0.25, 0.5, 1.0]) {
  for (const maxOpen of [1, 3, 5]) {
    const r = book(all, frac, maxOpen);
    console.log(`  ${(frac*100).toFixed(0).padStart(4)}%    ${maxOpen}    ${(frac*maxOpen).toFixed(2)}x  $${r.eq.toFixed(2).padStart(9)}  ${(r.monthly*100>=0?"+":"")+(r.monthly*100).toFixed(2)}%  ${(r.dd*100).toFixed(0).padStart(4)}%   ${r.taken}`);
  }
}
console.log(`\n  HOLDOUT ONLY (last 25%):`);
const ho = all.filter((x) => x.t >= cutH);
const hoDays = (t1 - cutH) / 86_400_000;
for (const frac of [0.5, 1.0]) {
  for (const maxOpen of [3, 5]) {
    const open: { exitT: number; ret: number; size: number }[] = [];
    let cash = 100, peak = 100, dd = 0;
    for (const sig of ho) {
      while (open.length && open[0]!.exitT <= sig.t) { const o = open.shift()!; cash += o.size * (o.ret - COST_BP/10_000); peak = Math.max(peak, cash); dd = Math.max(dd, (peak-cash)/peak); }
      if (open.length >= maxOpen) continue;
      open.push({ exitT: sig.exitT, ret: sig.ret, size: cash * frac });
      open.sort((a, b) => a.exitT - b.exitT);
    }
    for (const o of open) cash += o.size * (o.ret - COST_BP/10_000);
    console.log(`  ${(frac*100).toFixed(0).padStart(4)}%    ${maxOpen}     $${cash.toFixed(2).padStart(9)}  ${((Math.pow(cash/100, 30/hoDays)-1)*100>=0?"+":"")+((Math.pow(cash/100, 30/hoDays)-1)*100).toFixed(2)}%  ${(dd*100).toFixed(0).padStart(4)}%`);
  }
}
