/**
 * TWO PLAYS, OPPOSITE REGIMES.
 *
 *   npm run two:ict
 *
 * The census (row 58) found the same thing at every horizon: sweep BREADTH is the
 * only context that lifts the average pattern, and the most reliable losers are
 * bearish patterns fired while the market is broadly sweeping HIGHS - hangingMan,
 * sweepMoHigh, wideRangeBear all lose as shorts with |t| past the shifted null, so
 * the flip is a long. Bearish reversal candles during a broad upside sweep are
 * traps; price continues up.
 *
 * That is the mirror of row 57, which buys weekly-low sweeps late in a broad
 * DOWNSIDE flush. The two cannot fire together by construction - one needs lows
 * being swept market-wide, the other highs - so unlike row 57's failed attempt at
 * "more plays" (90% duplicates) these are structurally distinct.
 *
 * This script validates play B the way play A was validated: excess over drift,
 * costed, episode-clustered t, three-way split, then both in one book.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, atr, rsiWilder } from "../src/lib/engine/ict.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = "/tmp/nightshift-1h-3y";
const COST = Number(process.env.COST_BP ?? 14) / 10_000;
const MIN_BARS = 20_000;
const MAJORS = new Set(["BTC", "ETH", "SOL", "XRP", "XLM", "BNB", "DOGE", "AVAX", "LINK"]);

function rollExt(a: number[], n: number, mode: "max" | "min"): number[] {
  const out = new Array<number>(a.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 1; i < a.length; i++) {
    const j = i - 1;
    while (dq.length && (mode === "max" ? a[dq[dq.length - 1]!]! <= a[j]! : a[dq[dq.length - 1]!]! >= a[j]!)) dq.pop();
    dq.push(j);
    while (dq.length && dq[0]! < i - n) dq.shift();
    if (i >= n) out[i] = a[dq[0]!]!;
  }
  return out;
}

interface Book { sym: string; cs: Candle[]; atrA: number[]; rsi: number[];
  hi168: number[]; lo168: number[]; hi720: number[] }
const books: Book[] = [];
for (const f of readdirSync(CACHE)) {
  if (!f.endsWith("-USDT.json")) continue;
  const cs = parseKlines(JSON.parse(readFileSync(join(CACHE, f), "utf8")) as number[][]);
  if (cs.length < MIN_BARS) continue;
  const atrA = new Array<number>(cs.length).fill(NaN);
  for (let i = 20; i < cs.length; i++) atrA[i] = atr(cs, i);
  books.push({ sym: f.replace("-USDT.json", ""), cs, atrA, rsi: rsiWilder(cs, 14),
    hi168: rollExt(cs.map((c) => c.h), 168, "max"), lo168: rollExt(cs.map((c) => c.l), 168, "min"),
    hi720: rollExt(cs.map((c) => c.h), 720, "max") });
}

// Market-wide sweep breadth, over ALL pairs, strictly backward-looking.
const swLo: { t: number; sym: string }[] = [], swHi: { t: number; sym: string }[] = [];
for (const b of books) for (let i = 169; i < b.cs.length; i++) {
  const c = b.cs[i]!;
  if (c.l <= b.lo168[i]! && !(b.cs[i - 1]!.l <= b.lo168[i - 1]!)) swLo.push({ t: c.t, sym: b.sym });
  if (c.h >= b.hi168[i]! && !(b.cs[i - 1]!.h >= b.hi168[i - 1]!)) swHi.push({ t: c.t, sym: b.sym });
}
swLo.sort((a, b) => a.t - b.t); swHi.sort((a, b) => a.t - b.t);
const WIN = 6 * 3600_000;
function breadth(arr: { t: number; sym: string }[], t: number, sym: string) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m]!.t < t - WIN) lo = m + 1; else hi = m; }
  let n = 0;
  for (let k = lo; k < arr.length && arr[k]!.t < t; k++) if (arr[k]!.sym !== sym) n++;
  return n;
}

// Unconditional drift per horizon, so "excess" means excess over just holding.
const drift = new Map<number, number>();
for (const H of [24, 48]) {
  let s = 0, n = 0;
  for (const b of books) for (let i = 200; i + H < b.cs.length; i++) { s += (b.cs[i + H]!.c - b.cs[i]!.c) / b.cs[i]!.c; n++; }
  drift.set(H, s / n);
}

interface Ev { t: number; sym: string; ret: number }
interface Def { name: string; hold: number; majorsOnly: boolean;
  fn: (b: Book, i: number, bLo: number, bHi: number) => boolean }

const R = (cs: Candle[], i: number) => Math.max(1e-12, cs[i]!.h - cs[i]!.l);
const uw = (cs: Candle[], i: number) => (cs[i]!.h - Math.max(cs[i]!.o, cs[i]!.c)) / R(cs, i);
const lw = (cs: Candle[], i: number) => (Math.min(cs[i]!.o, cs[i]!.c) - cs[i]!.l) / R(cs, i);
const bf = (cs: Candle[], i: number) => Math.abs(cs[i]!.c - cs[i]!.o) / R(cs, i);

const DEFS: Def[] = [
  // ---- play A, row 57's settled form, for reference on this harness
  { name: "A wkLowWick+flush3", hold: 24, majorsOnly: true,
    fn: (b, i, bLo) => b.cs[i]!.l <= b.lo168[i]! && !(b.cs[i - 1]!.l <= b.lo168[i - 1]!) && lw(b.cs, i) >= 0.6 && bLo >= 3 },
  // ---- play B candidates: bearish candle, broad HIGH-sweep breadth, taken LONG
  { name: "B bearWick+flushHi3", hold: 24, majorsOnly: true,
    fn: (b, i, _l, bHi) => bHi >= 3 && b.cs[i]!.c < b.cs[i]!.o && uw(b.cs, i) >= 0.5 },
  { name: "B bearWick+flushHi3", hold: 48, majorsOnly: true,
    fn: (b, i, _l, bHi) => bHi >= 3 && b.cs[i]!.c < b.cs[i]!.o && uw(b.cs, i) >= 0.5 },
  { name: "B hangingMan+fHi3", hold: 48, majorsOnly: true,
    fn: (b, i, _l, bHi) => bHi >= 3 && lw(b.cs, i) >= 2 * bf(b.cs, i) && uw(b.cs, i) < 0.15 && bf(b.cs, i) < 0.4 && b.cs[i]!.c > b.cs[i - 3]!.c },
  { name: "B moHighSweep+fHi3", hold: 48, majorsOnly: true,
    fn: (b, i, _l, bHi) => bHi >= 3 && b.cs[i]!.h >= b.hi720[i]! && !(b.cs[i - 1]!.h >= b.hi720[i - 1]!) },
  { name: "B wideRangeDn+fHi3", hold: 48, majorsOnly: true,
    fn: (b, i, _l, bHi) => bHi >= 3 && R(b.cs, i) >= 2 * b.atrA[i]! && b.cs[i]!.c < b.cs[i]!.o },
];

function events(d: Def): Ev[] {
  const out: Ev[] = [];
  const dr = drift.get(d.hold)!;
  for (const b of books) {
    if (d.majorsOnly && !MAJORS.has(b.sym)) continue;
    for (let i = 205; i + d.hold < b.cs.length; i++) {
      if (!(b.atrA[i]! > 0)) continue;
      const c = b.cs[i]!;
      const bLo = breadth(swLo, c.t, b.sym), bHi = breadth(swHi, c.t, b.sym);
      if (!d.fn(b, i, bLo, bHi)) continue;
      const raw = (b.cs[i + d.hold]!.c - c.c) / c.c;
      out.push({ t: c.t, sym: b.sym, ret: raw - dr - COST });   // always LONG, excess over drift
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function episodes(evs: Ev[]) {
  const g: Ev[][] = [];
  for (const e of evs) {
    const last = g[g.length - 1];
    if (last && e.t - last[last.length - 1]!.t <= 24 * 3600_000) last.push(e); else g.push([e]);
  }
  return g;
}
function stats(evs: Ev[]) {
  const n = evs.length;
  if (n < 30) return null;
  const m = evs.reduce((a, b) => a + b.ret, 0) / n;
  const g = episodes(evs).map((x) => x.reduce((a, b) => a + b.ret, 0) / x.length);
  const gm = g.reduce((a, b) => a + b, 0) / g.length;
  const gsd = Math.sqrt(g.reduce((a, b) => a + (b - gm) ** 2, 0) / Math.max(1, g.length - 1)) || 1e-12;
  return { n, mean: m, ep: g.length, t: (gm / gsd) * Math.sqrt(g.length),
    win: evs.filter((x) => x.ret > 0).length / n };
}

const span = books[0]!.cs;
const T0 = span[0]!.t, T1 = span[span.length - 1]!.t;
const CV = T0 + (T1 - T0) * 0.5, CH = T0 + (T1 - T0) * 0.75;
const days = (T1 - T0) / 86_400_000;
console.log(`${books.length} pairs tracked for breadth · positions in ${[...MAJORS].length} majors · ${days.toFixed(0)} days · ${(COST*1e4).toFixed(0)}bp`);
console.log(`drift 24h ${(drift.get(24)!*100).toFixed(3)}%  48h ${(drift.get(48)!*100).toFixed(3)}%  (subtracted: every number below is excess over holding)\n`);
console.log("play                  hold     n   /mo   ep   excess    win     ep-t    TRAIN     VAL     HOLD");
console.log("─".repeat(100));
const built = new Map<string, Ev[]>();
for (const d of DEFS) {
  const evs = events(d);
  built.set(`${d.name}@${d.hold}`, evs);
  const a = stats(evs), tr = stats(evs.filter((x) => x.t < CV)),
    v = stats(evs.filter((x) => x.t >= CV && x.t < CH)), h = stats(evs.filter((x) => x.t >= CH));
  const f = (x: ReturnType<typeof stats>) => x ? `${(x.mean*100>=0?"+":"")+(x.mean*100).toFixed(2)}%`.padStart(8) : "     n/a";
  if (!a) { console.log(`${d.name.padEnd(22)}${String(d.hold).padStart(4)}h  ${String(evs.length).padStart(4)}  too few`); continue; }
  const stable = tr && v && h && tr.mean > 0 && v.mean > 0 && h.mean > 0;
  console.log(`${d.name.padEnd(22)}${String(d.hold).padStart(4)}h ${String(a.n).padStart(5)} ${(a.n/days*30).toFixed(1).padStart(5)} ${String(a.ep).padStart(4)} ` +
    `${((a.mean*100>=0?"+":"")+(a.mean*100).toFixed(2)+"%").padStart(8)} ${(a.win*100).toFixed(0).padStart(4)}%  ${a.t.toFixed(2).padStart(6)} ${f(tr)}${f(v)}${f(h)}` +
    `${stable && a.t > 2.5 ? "  *** keep" : stable ? "  (stable)" : ""}`);
}

/** Do A and B ever fire together? If they do, they are not two plays. */
const A = built.get("A wkLowWick+flush3@24")!;
for (const key of [...built.keys()].filter((k) => k.startsWith("B"))) {
  const B = built.get(key)!;
  const aTimes = A.map((e) => e.t);
  let near = 0;
  for (const e of B) if (aTimes.some((t) => Math.abs(t - e.t) <= 24 * 3600_000)) near++;
  console.log(`\noverlap ${key.padEnd(26)} ${((near / Math.max(1, B.length)) * 100).toFixed(0)}% of its entries within 24h of a play-A entry`);
}

/** Combined book. Slots are shared, so the plays compete for capital honestly. */
function book(evs: { t: number; ret: number; hold: number }[], frac: number, maxOpen: number) {
  const open: { exitT: number; ret: number; size: number }[] = [];
  let cash = 100, peak = 100, dd = 0, taken = 0, tsum = 0;
  for (const e of [...evs].sort((a, b) => a.t - b.t)) {
    while (open.length && open[0]!.exitT <= e.t) {
      const o = open.shift()!; cash += o.size * o.ret;
      peak = Math.max(peak, cash); dd = Math.max(dd, (peak - cash) / peak);
    }
    if (open.length >= maxOpen || cash <= 0) continue;
    open.push({ exitT: e.t + e.hold * 3600_000, ret: e.ret, size: cash * frac });
    open.sort((a, b) => a.exitT - b.exitT); taken++; tsum += e.ret;
  }
  for (const o of open) cash += o.size * o.ret;
  return { eq: cash, dd, taken, takenMean: taken ? tsum / taken : 0,
    monthly: cash > 0 ? Math.pow(cash / 100, 30 / days) - 1 : NaN };
}
const pick = "B bearWick+flushHi3@48";
const mix = [
  ...A.map((e) => ({ t: e.t, ret: e.ret, hold: 24 })),
  ...built.get(pick)!.map((e) => ({ t: e.t, ret: e.ret, hold: 48 })),
];
console.log(`\nBOOK — play A alone, play B alone (${pick}), and both sharing 5 slots`);
console.log("  gross    A only              B only              A+B");
for (const [frac, mo] of [[0.25, 5], [0.5, 5], [1.0, 5]] as const) {
  const fmt = (b: ReturnType<typeof book>) =>
    `$${b.eq.toFixed(0).padStart(5)} ${((b.monthly*100>=0?"+":"")+(b.monthly*100).toFixed(2)+"%").padStart(7)} ${(b.dd*100).toFixed(0).padStart(3)}%dd`;
  const a = book(A.map((e) => ({ t: e.t, ret: e.ret, hold: 24 })), frac, mo);
  const b = book(built.get(pick)!.map((e) => ({ t: e.t, ret: e.ret, hold: 48 })), frac, mo);
  const c = book(mix, frac, mo);
  console.log(`  ${(frac*mo).toFixed(2)}x   ${fmt(a)}   ${fmt(b)}   ${fmt(c)}`);
}
