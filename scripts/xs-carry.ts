/**
 * Cross-sectional funding carry.
 *
 *   npm run carry:ict
 *
 * The one strategy tested here with an economic mechanism rather than a pattern:
 * perpetual funding pays whoever holds the unpopular side. Short a pair whose
 * funding is positive and you RECEIVE it; long a pair whose funding is negative
 * and you receive it too. Rank the universe by funding, short the top and long
 * the bottom, and the basket collects the spread.
 *
 * Why it might clear where everything else failed: the return does not require a
 * price forecast, and it is dollar-neutral, so a market-wide flush is not
 * automatically a loss. Why it might not: measured spreads are a few bp per 8h
 * against a 14bp round trip, so the holding period has to be long enough for
 * carry to outrun the toll — which is exactly the trade-off board row 44 describes.
 *
 * Three-way split, costs charged, holdout scored once.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const PX_CACHE = join(process.env.TMPDIR ?? "/tmp", `nightshift-bt-15m-${process.argv[2] ?? "175"}`);
const FUND_CACHE = "/tmp/nightshift-funding";
const COST_BP = (5 + 2) * 2;

const syms: string[] = [];
const px = new Map<string, Map<number, number>>();
const fund = new Map<string, { t: number; r: number }[]>();
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const pf = join(PX_CACHE, `${a.instId}.json`);
  const ff = join(FUND_CACHE, `${a.symbol}.json`);
  if (!existsSync(pf) || !existsSync(ff)) continue;
  const cs: Candle[] = parseKlines(JSON.parse(readFileSync(pf, "utf8")) as number[][]);
  const fr = JSON.parse(readFileSync(ff, "utf8")) as { t: number; r: number }[];
  if (cs.length < 500 || fr.length < 100) continue;
  syms.push(a.symbol);
  px.set(a.symbol, new Map(cs.map((c) => [c.t, c.c])));
  fund.set(a.symbol, fr);
}
if (syms.length < 6) { console.log(`need >=6 pairs, have ${syms.length}`); process.exit(1); }

/** Price at or just before t (funding times land on 15m boundaries, but be safe). */
function priceAt(sym: string, t: number): number | null {
  const m = px.get(sym)!;
  for (let k = 0; k < 8; k++) {
    const v = m.get(t - k * 900_000);
    if (v && v > 0) return v;
  }
  return null;
}

// Shared funding timestamps
const times = fund.get(syms[0]!)!.map((x) => x.t)
  .filter((t) => syms.every((s) => fund.get(s)!.some((x) => x.t === t)))
  .sort((a, b) => a - b);
const rateAt = new Map<string, Map<number, number>>();
for (const s of syms) rateAt.set(s, new Map(fund.get(s)!.map((x) => [x.t, x.r])));

interface Period { t: number; ret: number; carry: number; pxRet: number }

/** hold = number of 8h funding periods held; k = pairs per side. */
function run(hold: number, k: number): Period[] {
  const out: Period[] = [];
  for (let i = 0; i + hold < times.length; i += hold) {
    const t0 = times[i]!, t1 = times[i + hold]!;
    const ranked = syms
      .map((s) => ({ s, r: rateAt.get(s)!.get(t0) }))
      .filter((x): x is { s: string; r: number } => x.r !== undefined)
      .sort((a, b) => a.r - b.r);
    if (ranked.length < 6) continue;
    const longs = ranked.slice(0, k), shorts = ranked.slice(-k);
    // Carry accrues every period held, on the rates in force at each one.
    let carry = 0;
    for (let j = i; j < i + hold; j++) {
      const tj = times[j]!;
      const sc = shorts.map((x) => rateAt.get(x.s)!.get(tj) ?? 0);
      const lc = longs.map((x) => rateAt.get(x.s)!.get(tj) ?? 0);
      carry += sc.reduce((a, b) => a + b, 0) / sc.length - lc.reduce((a, b) => a + b, 0) / lc.length;
    }
    const fwd = (s: string) => {
      const a = priceAt(s, t0), b = priceAt(s, t1);
      return a && b ? (b - a) / a : null;
    };
    const lr = longs.map((x) => fwd(x.s)).filter((v): v is number => v !== null);
    const sr = shorts.map((x) => fwd(x.s)).filter((v): v is number => v !== null);
    if (!lr.length || !sr.length) continue;
    const pxRet = lr.reduce((a, b) => a + b, 0) / lr.length - sr.reduce((a, b) => a + b, 0) / sr.length;
    out.push({ t: t0, carry, pxRet, ret: carry + pxRet - COST_BP / 10_000 });
  }
  return out;
}

function stat(rows: Period[]) {
  const n = rows.length;
  if (n < 15) return null;
  const m = rows.reduce((s, x) => s + x.ret, 0) / n;
  const sd = Math.sqrt(rows.reduce((s, x) => s + (x.ret - m) ** 2, 0) / n) || 1e-9;
  return {
    n, mean: m, t: (m / sd) * Math.sqrt(n),
    carry: rows.reduce((s, x) => s + x.carry, 0) / n,
    pxRet: rows.reduce((s, x) => s + x.pxRet, 0) / n,
    win: rows.filter((x) => x.ret > 0).length / n,
  };
}

const t0 = times[0]!, t1 = times[times.length - 1]!;
const cutV = t0 + (t1 - t0) * 0.5, cutH = t0 + (t1 - t0) * 0.75;
const days = (t1 - t0) / 86_400_000;
console.log(`${syms.length} pairs · ${times.length} funding periods · ${days.toFixed(0)} days · cost ${COST_BP}bp per rebalance\n`);
console.log("config              TRAIN                    VALIDATION               carry  pxRet  (per period, %)");
console.log("                     n   mean%     t          n   mean%     t");

const cands: { label: string; hold: number; k: number }[] = [];
for (const hold of [1, 3, 9, 21, 42]) for (const k of [2, 3, 4]) {
  cands.push({ label: `hold ${String(hold * 8).padStart(3)}h k${k}`, hold, k });
}
const scored = cands.map((c) => {
  const all = run(c.hold, c.k);
  return { c, all, tr: stat(all.filter((x) => x.t < cutV)), v: stat(all.filter((x) => x.t >= cutV && x.t < cutH)) };
}).filter((x) => x.tr && x.v);
scored.sort((a, b) => b.v!.t - a.v!.t);
for (const s of scored) {
  const f = (x: NonNullable<typeof s.tr>) =>
    `${String(x.n).padStart(4)} ${(x.mean*100>=0?"+":"")+(x.mean*100).toFixed(3)} ${x.t.toFixed(1).padStart(5)}`;
  console.log(`${s.c.label.padEnd(18)} ${f(s.tr!)}     ${f(s.v!)}     ` +
    `${(s.v!.carry*100>=0?"+":"")+(s.v!.carry*100).toFixed(3)} ${(s.v!.pxRet*100>=0?"+":"")+(s.v!.pxRet*100).toFixed(3)}`);
}

const eligible = scored.filter((s) => s.v!.mean > 0 && s.tr!.mean > 0);
console.log(`\n${eligible.length} of ${scored.length} configs positive on BOTH train and validation`);
if (!eligible.length) { console.log("Nothing qualifies — no holdout score."); process.exit(0); }
const pick = eligible[0]!;
console.log(`\nSELECTED: ${pick.c.label}  (val ${(pick.v!.mean*100).toFixed(3)}%/period, t ${pick.v!.t.toFixed(1)})`);
const hold = pick.all.filter((x) => x.t >= cutH);
const h = stat(hold);
if (!h) { console.log("holdout too thin"); process.exit(0); }
const holdDays = (t1 - cutH) / 86_400_000;
console.log(`\nHOLDOUT — scored once:  n=${h.n} over ${holdDays.toFixed(0)} days`);
console.log(`  mean ${(h.mean*100>=0?"+":"")+(h.mean*100).toFixed(4)}%/period  t ${h.t.toFixed(1)}  win ${(h.win*100).toFixed(0)}%`);
console.log(`  decomposition: carry ${(h.carry*100>=0?"+":"")+(h.carry*100).toFixed(4)}%  price ${(h.pxRet*100>=0?"+":"")+(h.pxRet*100).toFixed(4)}%  cost -${(COST_BP/100).toFixed(2)}%`);
for (const lev of [1, 2, 3, 5]) {
  let e = 100, peak = 100, dd = 0, blew = false;
  for (const x of hold) { e *= 1 + x.ret * lev; if (e <= 0.5) { blew = true; break; } peak = Math.max(peak, e); dd = Math.max(dd, (peak-e)/peak); }
  console.log(`  ${lev}x book -> $${blew ? "0 RUIN" : e.toFixed(2)}  maxDD ${(dd*100).toFixed(0)}%  ${blew?"":`${Math.pow(e/100, 30/holdDays).toFixed(2)}x/month`}`);
}
