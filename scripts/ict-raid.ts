/**
 * Liquidity-raid short study: what separates real distribution from a fake
 * double top, as RULES, and which stop placement survives.
 *
 *   npm run raid:ict
 *
 * Strictly causal. A swing high at j is only known at j+2, so nothing is used
 * before j+2 <= i. Entry is the close of the confirmation bar — a price that
 * actually existed.
 *
 * The arithmetic that frames everything below: flattening 100% at 1R makes the
 * realised payoff 1:1, so breakeven win rate is 50% plus costs (~52%). A 26-34%
 * win rate at 1:1 is -0.3R to -0.5R per trade. So the only question that matters
 * is whether any discriminator lifts win rate past ~52%, not whether it "helps".
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, atr, nyParts, isLondon, isNyAm, isSilver, isNyPm, isAsia, htfBias } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = join(process.env.TMPDIR ?? "/tmp", `nightshift-bt-15m-${process.argv[2] ?? "175"}`);
const FEE_BP = 5, SLIP_BP = 2;
const COST_R = (p: { stopPct: number }) => ((FEE_BP + SLIP_BP) * 2 / 10_000) / p.stopPct;

interface Raid {
  t: number; i: number; sym: string;
  entry: number; wickStop: number; bodyStop: number;
  // discriminators, all causal
  wickOnly: boolean;      // H2 pierced H1 but closed back below it
  neckBreak: boolean;     // closed below the low between the two highs
  displaced: boolean;     // confirmation body >= 1 ATR
  volUp: boolean;         // H2 volume > H1 volume
  premium: boolean;       // H2 above the 50% of the prior leg
  touches3: boolean;      // level tapped 3+ times
  killzone: boolean;
  htfDown: boolean;       // htfBias negative
  nineAm: boolean;        // H2 formed in the 9-10 NY hour
}

function findRaids(cs: Candle[], sym: string): Raid[] {
  const out: Raid[] = [];
  // confirmed swing highs/lows
  const hi: number[] = [], lo: number[] = [];
  for (let k = 2; k < cs.length - 2; k++) {
    const c = cs[k]!;
    if (c.h > cs[k-1]!.h && c.h > cs[k-2]!.h && c.h > cs[k+1]!.h && c.h > cs[k+2]!.h) hi.push(k);
    if (c.l < cs[k-1]!.l && c.l < cs[k-2]!.l && c.l < cs[k+1]!.l && c.l < cs[k+2]!.l) lo.push(k);
  }
  for (let i = 60; i < cs.length - 1; i++) {
    const c = cs[i]!;
    const a = atr(cs, i);
    if (!(a > 0)) continue;
    // two confirmed highs, both knowable now, within 0.4 ATR of each other
    const seen = hi.filter((j) => j + 2 <= i && j >= i - 80);
    if (seen.length < 2) continue;
    const j2 = seen[seen.length - 1]!, j1 = seen[seen.length - 2]!;
    if (i - j2 > 6) continue;                       // the raid must be recent
    const H1 = cs[j1]!.h, H2 = cs[j2]!.h;
    if (Math.abs(H2 - H1) > a * 0.4) continue;      // not a double top
    const level = Math.max(H1, H2);
    // the trough between them
    const mids = lo.filter((k) => k > j1 && k < j2);
    const neck = mids.length ? Math.min(...mids.map((k) => cs[k]!.l)) : Math.min(cs[j1]!.l, cs[j2]!.l);
    // confirmation: this bar closes red and below the neck OR below both highs
    if (c.c >= c.o) continue;
    const body = Math.abs(c.c - c.o);
    // prior leg for the premium test
    const legLo = Math.min(...cs.slice(Math.max(0, j1 - 40), j1 + 1).map((x) => x.l));
    const fib50 = legLo + (level - legLo) * 0.5;
    const touches = cs.slice(Math.max(0, j1 - 20), i + 1).filter((x) => x.h >= level - a * 0.25 && x.h <= level + a * 0.4).length;
    const p = nyParts(cs[j2]!.t);
    out.push({
      t: c.t, i, sym,
      entry: c.c,
      wickStop: level + a * 0.25,
      bodyStop: Math.max(cs[j1]!.c, cs[j2]!.c) + a * 0.25,
      wickOnly: cs[j2]!.c < H1 && H2 > H1,
      neckBreak: c.c < neck,
      displaced: body >= a,
      volUp: (cs[j2]!.v || 0) > (cs[j1]!.v || 0),
      premium: H2 > fib50,
      touches3: touches >= 3,
      killzone: isLondon(c.t) || isNyAm(c.t) || isSilver(c.t) || isNyPm(c.t) || isAsia(c.t),
      htfDown: htfBias(cs, i) === -1,
      nineAm: p.h === 9,
    });
  }
  return out;
}

/** Flatten at 1R, stop at the chosen level. Returns realised R net of cost. */
function resolve(cs: Candle[], r: Raid, stop: number): { r: number; stopPct: number } | null {
  const entry = r.entry;
  const dist = stop - entry;
  if (!(dist > 0)) return null;
  const stopPct = dist / entry;
  if (stopPct > 0.05) return null;                  // absurd, skip
  const target = entry - dist;                       // 1R
  for (let k = r.i + 1; k < Math.min(cs.length, r.i + 96); k++) {
    const c = cs[k]!;
    // stop first within the bar: the conservative assumption
    if (c.h >= stop) return { r: -1 - COST_R({ stopPct }), stopPct };
    if (c.l <= target) return { r: 1 - COST_R({ stopPct }), stopPct };
  }
  const last = cs[Math.min(cs.length - 1, r.i + 96)]!;
  return { r: (entry - last.c) / dist - COST_R({ stopPct }), stopPct };
}

const books: { sym: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 200) books.push({ sym: a.symbol, cs });
}
if (!books.length) { console.log(`no cache at ${CACHE}`); process.exit(1); }

const raids: { raid: Raid; wick: { r: number; stopPct: number } | null; body: { r: number; stopPct: number } | null }[] = [];
for (const b of books) {
  for (const r of findRaids(b.cs, b.sym)) {
    raids.push({ raid: r, wick: resolve(b.cs, r, r.wickStop), body: resolve(b.cs, r, r.bodyStop) });
  }
}
raids.sort((a, b) => a.raid.t - b.raid.t);
const t0 = raids[0]!.raid.t, t1 = raids[raids.length - 1]!.raid.t;
const cut = t0 + (t1 - t0) * 0.6;

function score(rows: { r: number; stopPct: number }[]) {
  const n = rows.length;
  if (n < 10) return null;
  const win = rows.filter((x) => x.r > 0).length / n;
  const avg = rows.reduce((s, x) => s + x.r, 0) / n;
  const sd = Math.sqrt(rows.reduce((s, x) => s + (x.r - avg) ** 2, 0) / n) || 1;
  const medStop = [...rows.map((x) => x.stopPct)].sort((a, b) => a - b)[Math.floor(n / 2)]!;
  return { n, win, avg, t: (avg / sd) * Math.sqrt(n), medStop };
}

const FILTERS: { label: string; f: (r: Raid) => boolean }[] = [
  { label: "ALL raids (baseline)",      f: () => true },
  { label: "wick-only rejection",       f: (r) => r.wickOnly },
  { label: "closed below neckline",     f: (r) => r.neckBreak },
  { label: "displacement >= 1 ATR",     f: (r) => r.displaced },
  { label: "volume up on 2nd high",     f: (r) => r.volUp },
  { label: "volume DOWN on 2nd high",   f: (r) => !r.volUp },
  { label: "in premium (>50% of leg)",  f: (r) => r.premium },
  { label: "level tapped 3+ times",     f: (r) => r.touches3 },
  { label: "killzone only",             f: (r) => r.killzone },
  { label: "HTF bias down",             f: (r) => r.htfDown },
  { label: "2nd high in 9-10 NY",       f: (r) => r.nineAm },
  { label: "wickOnly + neckBreak",      f: (r) => r.wickOnly && r.neckBreak },
  { label: "wickOnly + displaced",      f: (r) => r.wickOnly && r.displaced },
  { label: "neckBreak + displaced",     f: (r) => r.neckBreak && r.displaced },
  { label: "wickOnly+neck+displaced",   f: (r) => r.wickOnly && r.neckBreak && r.displaced },
  { label: "A+ (wick+neck+disp+KZ+HTF)", f: (r) => r.wickOnly && r.neckBreak && r.displaced && r.killzone && r.htfDown },
];

console.log(`${books.length} books · ${((t1 - t0) / 86_400_000).toFixed(0)} days · ${raids.length} raid events`);
console.log(`flatten at 1R -> payoff 1:1 -> BREAKEVEN WIN RATE IS ~52% after ${((FEE_BP+SLIP_BP)*2)}bp costs\n`);

for (const stopKind of ["wick", "body"] as const) {
  console.log(`=== stop ABOVE THE ${stopKind === "wick" ? "WICK" : "HIGHEST CLOSE (body)"} ===`);
  console.log("filter                          TRAIN                    HOLDOUT                  medStop");
  console.log("                                 n   win    avgR          n   win    avgR    t");
  console.log("─".repeat(96));
  for (const flt of FILTERS) {
    const sel = raids.filter((x) => flt.f(x.raid) && x[stopKind]);
    const tr = score(sel.filter((x) => x.raid.t < cut).map((x) => x[stopKind]!));
    const ho = score(sel.filter((x) => x.raid.t >= cut).map((x) => x[stopKind]!));
    if (!tr || !ho) { console.log(`${flt.label.padEnd(30)} too few`); continue; }
    const mark = ho.win > 0.52 ? "  <<< clears breakeven" : "";
    console.log(
      `${flt.label.padEnd(30)} ${String(tr.n).padStart(5)} ${(tr.win*100).toFixed(0).padStart(4)}% ${(tr.avg>=0?"+":"")}${tr.avg.toFixed(3)}` +
      `    ${String(ho.n).padStart(5)} ${(ho.win*100).toFixed(0).padStart(4)}% ${(ho.avg>=0?"+":"")}${ho.avg.toFixed(3)} ${ho.t.toFixed(1).padStart(5)}` +
      `   ${(ho.medStop*100).toFixed(2)}%${mark}`,
    );
  }
  console.log();
}

// ── what 18% of working cash per 1R does to the best filter ────────────────
const APLUS = (r: Raid) => r.wickOnly && r.neckBreak && r.displaced && r.killzone && r.htfDown;
const aplus = raids.filter((x) => APLUS(x.raid) && x.body).map((x) => x.body!);
if (aplus.length > 20) {
  console.log(`=== risk of ruin: A+ body-stop, ${aplus.length} trades, block bootstrap ===`);
  let seed = 99991;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
  for (const riskPct of [0.18, 0.10, 0.05, 0.02]) {
    let ruin = 0, hit1k = 0; const ends: number[] = [];
    for (let p = 0; p < 4000; p++) {
      let cash = 100, banked = 0, blew = false;
      for (let k = 0; k < aplus.length; k++) {
        const t = aplus[Math.floor(rnd() * aplus.length)]!;
        cash += t.r * cash * riskPct;
        if (cash <= 0.5) { blew = true; break; }
        if (cash + banked >= 1000) hit1k++;
        // secure gains: bank 60% of each new high above the start
        if (cash > 100) { const take = (cash - 100) * 0.6; banked += take; cash -= take; }
      }
      if (blew) ruin++;
      ends.push(cash + banked);
    }
    ends.sort((a, b) => a - b);
    console.log(
      `  ${String(riskPct * 100).padStart(3)}% per 1R -> median $${ends[2000]!.toFixed(0).padStart(4)}` +
      `  P5 $${ends[200]!.toFixed(0).padStart(4)}  P95 $${ends[3800]!.toFixed(0).padStart(5)}` +
      `  P(ruin) ${((ruin / 4000) * 100).toFixed(1).padStart(4)}%  P($1k) ${((hit1k / 4000) * 100).toFixed(1)}%`,
    );
  }
  const w = aplus.filter((x) => x.r > 0).length / aplus.length;
  console.log(`\n  A+ win ${(w * 100).toFixed(0)}%, so P(5 straight losses) = ${Math.pow(1 - w, 5).toFixed(3)}`);
  console.log(`  5 opens x 18% = 90% of the book on one correlated flush.`);
}
