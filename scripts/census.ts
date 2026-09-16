/**
 * CANDLE-PATTERN CENSUS, CROSSED WITH MARKET CONTEXT.
 *
 *   npm run census:ict              # 24h horizon
 *   HOLD=4 npm run census:ict       # scalp horizon
 *
 * Rows 1-56 tested patterns one at a time and nearly all of them failed. Row 57
 * found out why one of them worked: not the candle, but the market state around
 * it - a weekly-low sweep pays +1.43% when three other pairs are sweeping too and
 * -0.24% when none are. Breadth was the strongest conditioner in the project, and
 * it was never applied to anything except the one play it was found on.
 *
 * So this is the cross-product instead of the list: every classical candlestick
 * pattern, every ICT/price-action primitive, each measured inside every context.
 * The question is not "does the hammer work" - rows 1-56 answered that - it is
 * "is there a CELL where a known pattern works, and is the winning cell the same
 * kind of cell across unrelated patterns?" A common denominator would show up as
 * one context column lighting up for many pattern rows.
 *
 * Discipline, because this is ~700 simultaneous tests:
 *   - excess over the unconditional forward return, so crypto drift is not an edge
 *   - costed at 14bp
 *   - t clustered on the calendar day, never on the trade
 *   - a null from circularly shifting forward returns, preserving pattern
 *     frequency and cross-pair correlation, to get the max |t| chance produces
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, atr, rsiWilder } from "../src/lib/engine/ict.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = "/tmp/nightshift-1h-3y";
const COST = Number(process.env.COST_BP ?? 14) / 10_000;
const HOLD = Number(process.env.HOLD ?? 24);
const MIN_BARS = 20_000;
const MIN_N = 80;          // a cell needs this many fires
const MIN_DAYS = 40;       // ...spread over this many days, or it is one episode

/** Rolling extreme over the `n` bars STRICTLY BEFORE i, via monotonic deque. */
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

interface Book {
  sym: string; cs: Candle[];
  atrA: number[]; rsi: number[]; sma: number[];
  hi168: number[]; lo168: number[]; hi24: number[]; lo24: number[]; hi720: number[]; lo720: number[];
  fwd: number[]; atrPct: number[];
}

const books: Book[] = [];
for (const f of readdirSync(CACHE)) {
  if (!f.endsWith("-USDT.json")) continue;
  const cs = parseKlines(JSON.parse(readFileSync(join(CACHE, f), "utf8")) as number[][]);
  if (cs.length < MIN_BARS) continue;
  const close = cs.map((c) => c.c), high = cs.map((c) => c.h), low = cs.map((c) => c.l);
  const atrA = new Array<number>(cs.length).fill(NaN);
  for (let i = 20; i < cs.length; i++) atrA[i] = atr(cs, i);
  const sma = new Array<number>(cs.length).fill(NaN);
  let run = 0;
  for (let i = 0; i < cs.length; i++) {
    run += close[i]!;
    if (i >= 200) run -= close[i - 200]!;
    if (i >= 199) sma[i] = run / 200;
  }
  const fwd = new Array<number>(cs.length).fill(NaN);
  for (let i = 0; i + HOLD < cs.length; i++) fwd[i] = (close[i + HOLD]! - close[i]!) / close[i]!;
  books.push({
    sym: f.replace("-USDT.json", ""), cs, atrA, rsi: rsiWilder(cs, 14), sma,
    hi168: rollExt(high, 168, "max"), lo168: rollExt(low, 168, "min"),
    hi24: rollExt(high, 24, "max"), lo24: rollExt(low, 24, "min"),
    hi720: rollExt(high, 720, "max"), lo720: rollExt(low, 720, "min"),
    fwd, atrPct: atrA.map((a, i) => a / close[i]!),
  });
}
if (books.length < 5) { console.log(`only ${books.length} usable pairs`); process.exit(1); }

/**
 * Market-wide sweep breadth. Weekly-low first touches across ALL pairs, merged,
 * so "how much of the market is flushing right now" is one number. Strictly
 * backward-looking: only touches that closed before this bar count.
 */
const sweepLo: { t: number; sym: string }[] = [];
const sweepHi: { t: number; sym: string }[] = [];
for (const b of books) {
  for (let i = 169; i < b.cs.length; i++) {
    const c = b.cs[i]!;
    if (c.l <= b.lo168[i]! && !(b.cs[i - 1]!.l <= b.lo168[i - 1]!)) sweepLo.push({ t: c.t, sym: b.sym });
    if (c.h >= b.hi168[i]! && !(b.cs[i - 1]!.h >= b.hi168[i - 1]!)) sweepHi.push({ t: c.t, sym: b.sym });
  }
}
sweepLo.sort((a, b) => a.t - b.t); sweepHi.sort((a, b) => a.t - b.t);
const WIN = 6 * 3600_000;
function breadth(arr: { t: number; sym: string }[], t: number, sym: string) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m]!.t < t - WIN) lo = m + 1; else hi = m; }
  let n = 0;
  for (let k = lo; k < arr.length && arr[k]!.t < t; k++) if (arr[k]!.sym !== sym) n++;
  return n;
}

// ---------------------------------------------------------------- patterns
interface Pat { name: string; side: "long" | "short"; fn: (i: number) => boolean }

function patterns(b: Book): Pat[] {
  const cs = b.cs;
  const R = (i: number) => Math.max(1e-12, cs[i]!.h - cs[i]!.l);
  const B = (i: number) => Math.abs(cs[i]!.c - cs[i]!.o);
  const bf = (i: number) => B(i) / R(i);
  const uw = (i: number) => (cs[i]!.h - Math.max(cs[i]!.o, cs[i]!.c)) / R(i);
  const lw = (i: number) => (Math.min(cs[i]!.o, cs[i]!.c) - cs[i]!.l) / R(i);
  const up = (i: number) => cs[i]!.c > cs[i]!.o;
  const dn = (i: number) => cs[i]!.c < cs[i]!.o;
  const a = (i: number) => b.atrA[i]!;
  // "in a downtrend" for the reversal patterns that require one
  const wasDown = (i: number) => cs[i]!.c < cs[i - 3]!.c;
  const wasUp = (i: number) => cs[i]!.c > cs[i - 3]!.c;
  const eq = (x: number, y: number, tol: number) => Math.abs(x - y) <= tol;

  return [
    // ---- single bar, classical
    { name: "hammer", side: "long", fn: (i) => lw(i) >= 2 * bf(i) && uw(i) < 0.15 && bf(i) < 0.4 && wasDown(i) },
    { name: "invHammer", side: "long", fn: (i) => uw(i) >= 2 * bf(i) && lw(i) < 0.15 && bf(i) < 0.4 && wasDown(i) },
    { name: "hangingMan", side: "short", fn: (i) => lw(i) >= 2 * bf(i) && uw(i) < 0.15 && bf(i) < 0.4 && wasUp(i) },
    { name: "shootingStar", side: "short", fn: (i) => uw(i) >= 2 * bf(i) && lw(i) < 0.15 && bf(i) < 0.4 && wasUp(i) },
    { name: "dojiStd", side: "long", fn: (i) => bf(i) <= 0.1 },
    { name: "dragonflyDoji", side: "long", fn: (i) => bf(i) <= 0.1 && lw(i) >= 0.7 },
    { name: "gravestoneDoji", side: "short", fn: (i) => bf(i) <= 0.1 && uw(i) >= 0.7 },
    { name: "marubozuBull", side: "long", fn: (i) => bf(i) >= 0.9 && up(i) },
    { name: "marubozuBear", side: "short", fn: (i) => bf(i) >= 0.9 && dn(i) },
    { name: "spinningTop", side: "long", fn: (i) => bf(i) <= 0.3 && uw(i) >= 0.25 && lw(i) >= 0.25 },
    { name: "beltHoldBull", side: "long", fn: (i) => up(i) && lw(i) <= 0.02 && bf(i) >= 0.7 },
    { name: "beltHoldBear", side: "short", fn: (i) => dn(i) && uw(i) <= 0.02 && bf(i) >= 0.7 },
    { name: "pinBarBull", side: "long", fn: (i) => lw(i) >= 0.6 },
    { name: "pinBarBear", side: "short", fn: (i) => uw(i) >= 0.6 },
    { name: "wideRangeBull", side: "long", fn: (i) => R(i) >= 2 * a(i) && up(i) },
    { name: "wideRangeBear", side: "short", fn: (i) => R(i) >= 2 * a(i) && dn(i) },
    { name: "narrowRange7", side: "long", fn: (i) => { for (let k = i - 6; k < i; k++) if (R(k) <= R(i)) return false; return true; } },

    // ---- two bar
    { name: "bullEngulf", side: "long", fn: (i) => dn(i - 1) && up(i) && cs[i]!.c >= cs[i - 1]!.o && cs[i]!.o <= cs[i - 1]!.c },
    { name: "bearEngulf", side: "short", fn: (i) => up(i - 1) && dn(i) && cs[i]!.c <= cs[i - 1]!.o && cs[i]!.o >= cs[i - 1]!.c },
    { name: "bullHarami", side: "long", fn: (i) => dn(i - 1) && up(i) && cs[i]!.o >= cs[i - 1]!.c && cs[i]!.c <= cs[i - 1]!.o },
    { name: "bearHarami", side: "short", fn: (i) => up(i - 1) && dn(i) && cs[i]!.o <= cs[i - 1]!.c && cs[i]!.c >= cs[i - 1]!.o },
    { name: "piercing", side: "long", fn: (i) => dn(i - 1) && up(i) && cs[i]!.o < cs[i - 1]!.c && cs[i]!.c > (cs[i - 1]!.o + cs[i - 1]!.c) / 2 && cs[i]!.c < cs[i - 1]!.o },
    { name: "darkCloud", side: "short", fn: (i) => up(i - 1) && dn(i) && cs[i]!.o > cs[i - 1]!.c && cs[i]!.c < (cs[i - 1]!.o + cs[i - 1]!.c) / 2 && cs[i]!.c > cs[i - 1]!.o },
    { name: "tweezerBottom", side: "long", fn: (i) => eq(cs[i]!.l, cs[i - 1]!.l, 0.1 * a(i)) && dn(i - 1) && up(i) },
    { name: "tweezerTop", side: "short", fn: (i) => eq(cs[i]!.h, cs[i - 1]!.h, 0.1 * a(i)) && up(i - 1) && dn(i) },
    { name: "insideBar", side: "long", fn: (i) => cs[i]!.h <= cs[i - 1]!.h && cs[i]!.l >= cs[i - 1]!.l },
    { name: "outsideBarUp", side: "long", fn: (i) => cs[i]!.h > cs[i - 1]!.h && cs[i]!.l < cs[i - 1]!.l && up(i) },
    { name: "outsideBarDn", side: "short", fn: (i) => cs[i]!.h > cs[i - 1]!.h && cs[i]!.l < cs[i - 1]!.l && dn(i) },
    { name: "kickerBull", side: "long", fn: (i) => dn(i - 1) && up(i) && cs[i]!.o > cs[i - 1]!.o },
    { name: "kickerBear", side: "short", fn: (i) => up(i - 1) && dn(i) && cs[i]!.o < cs[i - 1]!.o },
    { name: "sepLinesBull", side: "long", fn: (i) => dn(i - 1) && up(i) && eq(cs[i]!.o, cs[i - 1]!.o, 0.05 * a(i)) },

    // ---- three bar and longer
    { name: "morningStar", side: "long", fn: (i) => dn(i - 2) && bf(i - 1) < 0.3 && up(i) && cs[i]!.c > (cs[i - 2]!.o + cs[i - 2]!.c) / 2 },
    { name: "eveningStar", side: "short", fn: (i) => up(i - 2) && bf(i - 1) < 0.3 && dn(i) && cs[i]!.c < (cs[i - 2]!.o + cs[i - 2]!.c) / 2 },
    { name: "abandonBabyBull", side: "long", fn: (i) => dn(i - 2) && bf(i - 1) <= 0.1 && cs[i - 1]!.h < cs[i - 2]!.l && cs[i]!.l > cs[i - 1]!.h && up(i) },
    { name: "abandonBabyBear", side: "short", fn: (i) => up(i - 2) && bf(i - 1) <= 0.1 && cs[i - 1]!.l > cs[i - 2]!.h && cs[i]!.h < cs[i - 1]!.l && dn(i) },
    { name: "3whiteSoldiers", side: "long", fn: (i) => up(i) && up(i - 1) && up(i - 2) && cs[i]!.c > cs[i - 1]!.c && cs[i - 1]!.c > cs[i - 2]!.c && bf(i) > 0.5 && bf(i - 1) > 0.5 },
    { name: "3blackCrows", side: "short", fn: (i) => dn(i) && dn(i - 1) && dn(i - 2) && cs[i]!.c < cs[i - 1]!.c && cs[i - 1]!.c < cs[i - 2]!.c && bf(i) > 0.5 && bf(i - 1) > 0.5 },
    { name: "3insideUp", side: "long", fn: (i) => dn(i - 2) && cs[i - 1]!.h <= cs[i - 2]!.h && cs[i - 1]!.l >= cs[i - 2]!.l && up(i) && cs[i]!.c > cs[i - 2]!.o },
    { name: "3insideDown", side: "short", fn: (i) => up(i - 2) && cs[i - 1]!.h <= cs[i - 2]!.h && cs[i - 1]!.l >= cs[i - 2]!.l && dn(i) && cs[i]!.c < cs[i - 2]!.o },
    { name: "3outsideUp", side: "long", fn: (i) => dn(i - 2) && up(i - 1) && cs[i - 1]!.c > cs[i - 2]!.o && up(i) && cs[i]!.c > cs[i - 1]!.c },
    { name: "3outsideDown", side: "short", fn: (i) => up(i - 2) && dn(i - 1) && cs[i - 1]!.c < cs[i - 2]!.o && dn(i) && cs[i]!.c < cs[i - 1]!.c },
    { name: "3lineStrikeBull", side: "long", fn: (i) => up(i - 3) && up(i - 2) && up(i - 1) && dn(i) && cs[i]!.c < cs[i - 3]!.o && cs[i]!.o > cs[i - 1]!.c },
    { name: "3lineStrikeBear", side: "short", fn: (i) => dn(i - 3) && dn(i - 2) && dn(i - 1) && up(i) && cs[i]!.c > cs[i - 3]!.o && cs[i]!.o < cs[i - 1]!.c },
    { name: "risingThree", side: "long", fn: (i) => up(i - 4) && bf(i - 4) > 0.5 && dn(i - 3) && dn(i - 2) && dn(i - 1) && cs[i - 1]!.l > cs[i - 4]!.l && up(i) && cs[i]!.c > cs[i - 4]!.h },
    { name: "fallingThree", side: "short", fn: (i) => dn(i - 4) && bf(i - 4) > 0.5 && up(i - 3) && up(i - 2) && up(i - 1) && cs[i - 1]!.h < cs[i - 4]!.h && dn(i) && cs[i]!.c < cs[i - 4]!.l },
    { name: "hikkakeBull", side: "long", fn: (i) => cs[i - 2]!.h <= cs[i - 3]!.h && cs[i - 2]!.l >= cs[i - 3]!.l && cs[i - 1]!.l < cs[i - 2]!.l && cs[i]!.c > cs[i - 2]!.h },
    { name: "hikkakeBear", side: "short", fn: (i) => cs[i - 2]!.h <= cs[i - 3]!.h && cs[i - 2]!.l >= cs[i - 3]!.l && cs[i - 1]!.h > cs[i - 2]!.h && cs[i]!.c < cs[i - 2]!.l },

    // ---- ICT / price-action primitives
    { name: "fvgUpFormed", side: "long", fn: (i) => cs[i]!.l > cs[i - 2]!.h },
    { name: "fvgDnFormed", side: "short", fn: (i) => cs[i]!.h < cs[i - 2]!.l },
    { name: "fvgUpFilled", side: "long", fn: (i) => { for (let k = i - 24; k <= i - 3; k++) { if (k < 2) continue; if (cs[k]!.l > cs[k - 2]!.h && cs[i]!.l <= cs[k - 2]!.h && cs[i - 1]!.l > cs[k - 2]!.h) return true; } return false; } },
    { name: "fvgDnFilled", side: "short", fn: (i) => { for (let k = i - 24; k <= i - 3; k++) { if (k < 2) continue; if (cs[k]!.h < cs[k - 2]!.l && cs[i]!.h >= cs[k - 2]!.l && cs[i - 1]!.h < cs[k - 2]!.l) return true; } return false; } },
    { name: "displaceUp", side: "long", fn: (i) => R(i) >= 2 * a(i) && (cs[i]!.c - cs[i]!.l) / R(i) >= 0.8 },
    { name: "displaceDn", side: "short", fn: (i) => R(i) >= 2 * a(i) && (cs[i]!.h - cs[i]!.c) / R(i) >= 0.8 },
    { name: "sweepWkLow", side: "long", fn: (i) => cs[i]!.l <= b.lo168[i]! && !(cs[i - 1]!.l <= b.lo168[i - 1]!) },
    { name: "sweepWkHigh", side: "short", fn: (i) => cs[i]!.h >= b.hi168[i]! && !(cs[i - 1]!.h >= b.hi168[i - 1]!) },
    { name: "sweepDayLow", side: "long", fn: (i) => cs[i]!.l <= b.lo24[i]! && !(cs[i - 1]!.l <= b.lo24[i - 1]!) },
    { name: "sweepDayHigh", side: "short", fn: (i) => cs[i]!.h >= b.hi24[i]! && !(cs[i - 1]!.h >= b.hi24[i - 1]!) },
    { name: "sweepMoLow", side: "long", fn: (i) => cs[i]!.l <= b.lo720[i]! && !(cs[i - 1]!.l <= b.lo720[i - 1]!) },
    { name: "sweepMoHigh", side: "short", fn: (i) => cs[i]!.h >= b.hi720[i]! && !(cs[i - 1]!.h >= b.hi720[i - 1]!) },
    { name: "cisdUp", side: "long", fn: (i) => { if (!up(i)) return false; let k = i - 1, hi = -Infinity, seen = 0; while (k >= 0 && dn(k) && seen < 6) { hi = Math.max(hi, cs[k]!.o); k--; seen++; } return seen >= 2 && cs[i]!.c > hi; } },
    { name: "cisdDn", side: "short", fn: (i) => { if (!dn(i)) return false; let k = i - 1, lo = Infinity, seen = 0; while (k >= 0 && up(k) && seen < 6) { lo = Math.min(lo, cs[k]!.o); k--; seen++; } return seen >= 2 && cs[i]!.c < lo; } },
    { name: "obRetestBull", side: "long", fn: (i) => { for (let k = i - 20; k <= i - 2; k++) { if (k < 1) continue; if (R(k) >= 2 * a(k) && up(k) && dn(k - 1)) { const top = Math.max(cs[k - 1]!.o, cs[k - 1]!.c); if (cs[i]!.l <= top && cs[i - 1]!.l > top) return true; } } return false; } },
    { name: "obRetestBear", side: "short", fn: (i) => { for (let k = i - 20; k <= i - 2; k++) { if (k < 1) continue; if (R(k) >= 2 * a(k) && dn(k) && up(k - 1)) { const bot = Math.min(cs[k - 1]!.o, cs[k - 1]!.c); if (cs[i]!.h >= bot && cs[i - 1]!.h < bot) return true; } } return false; } },
    { name: "rsiOversold", side: "long", fn: (i) => b.rsi[i]! < 25 && b.rsi[i - 1]! >= 25 },
    { name: "rsiOverbought", side: "short", fn: (i) => b.rsi[i]! > 75 && b.rsi[i - 1]! <= 75 },
  ];
}

// ---------------------------------------------------------------- contexts
const CTX = [
  "all", "flushLo>=3", "flushLo>=6", "flushHi>=3", "volHigh", "volLow",
  "aboveSMA200", "belowSMA200", "discount", "premium", "NY", "LDN", "ASIA",
] as const;
type Ctx = (typeof CTX)[number];

/** Volatility terciles, computed once over the pooled sample so they are fixed. */
const allAtrPct: number[] = [];
for (const b of books) for (let i = 200; i < b.cs.length; i++) if (isFinite(b.atrPct[i]!)) allAtrPct.push(b.atrPct[i]!);
allAtrPct.sort((x, y) => x - y);
const VLO = allAtrPct[Math.floor(allAtrPct.length / 3)]!;
const VHI = allAtrPct[Math.floor((2 * allAtrPct.length) / 3)]!;

/** Unconditional forward return, the baseline every pattern has to beat. */
let baseS = 0, baseN = 0;
for (const b of books) for (let i = 200; i + HOLD < b.cs.length; i++) { baseS += b.fwd[i]!; baseN++; }
const BASE = baseS / baseN;

// cell key -> day -> {s,n}
type Cell = Map<number, { s: number; n: number }>;
const cells = new Map<string, Cell>();
function push(key: string, day: number, r: number) {
  let c = cells.get(key);
  if (!c) { c = new Map(); cells.set(key, c); }
  const d = c.get(day);
  if (d) { d.s += r; d.n++; } else c.set(day, { s: r, n: 1 });
}

const PATS = patterns(books[0]!).map((p) => ({ name: p.name, side: p.side }));
let fires = 0;
for (const b of books) {
  const ps = patterns(b);
  const hourOf = (t: number) => new Date(t).getUTCHours();
  for (let i = 205; i + HOLD < b.cs.length; i++) {
    const c = b.cs[i]!;
    if (!isFinite(b.atrA[i]!) || !(b.atrA[i]! > 0) || !isFinite(b.sma[i]!)) continue;
    const fwd = b.fwd[i]!;
    const bLo = breadth(sweepLo, c.t, b.sym), bHi = breadth(sweepHi, c.t, b.sym);
    const h = hourOf(c.t);
    const pos = (c.c - b.lo168[i]!) / Math.max(1e-12, b.hi168[i]! - b.lo168[i]!);
    const on: Ctx[] = ["all"];
    if (bLo >= 3) on.push("flushLo>=3");
    if (bLo >= 6) on.push("flushLo>=6");
    if (bHi >= 3) on.push("flushHi>=3");
    if (b.atrPct[i]! >= VHI) on.push("volHigh");
    if (b.atrPct[i]! <= VLO) on.push("volLow");
    on.push(c.c > b.sma[i]! ? "aboveSMA200" : "belowSMA200");
    if (pos <= 0.3) on.push("discount");
    if (pos >= 0.7) on.push("premium");
    if (h >= 13 && h < 21) on.push("NY");
    else if (h >= 7 && h < 13) on.push("LDN");
    else on.push("ASIA");
    const day = Math.floor(c.t / 86_400_000);
    for (const p of ps) {
      if (!p.fn(i)) continue;
      fires++;
      // excess over the drift baseline, signed by the pattern's side, then costed
      const ex = (p.side === "long" ? fwd - BASE : -(fwd - BASE)) - COST;
      for (const ctx of on) push(`${p.name}|${ctx}`, day, ex);
    }
  }
}

/**
 * Cluster-robust t on the POOLED mean, clustering on the calendar day.
 *
 * The first version of this reported the mean of per-day means next to a t
 * computed on those day means, and every single cell came out positive - longs on
 * low sweeps AND shorts on high sweeps alike. That is not an edge, it is the
 * weighting: the days that fire most are the days that lose most for whichever
 * direction is firing, so equal-weighting days quietly discards the damage.
 *
 * Worse, it is not causally reachable. Splitting a fixed daily budget across a
 * day's signals needs the day's signal count, which includes signals that fire
 * AFTER the entry. So the pooled mean is the economic quantity, and the standard
 * error is what has to absorb the within-day correlation:
 *
 *     SE^2 = sum_d (S_d - n_d * xbar)^2 / N^2
 *
 * which is the usual cluster-robust variance of a sample mean, needing only the
 * per-day sum and count that are already stored.
 */
function tOf(c: Cell) {
  let N = 0, S = 0;
  for (const d of c.values()) { N += d.n; S += d.s; }
  const days = c.size;
  if (days < 2 || N < 2) return null;
  const xbar = S / N;
  let v = 0;
  for (const d of c.values()) { const g = d.s - d.n * xbar; v += g * g; }
  const se = Math.sqrt(v) / N || 1e-12;
  // dayMean is kept only to show how much of the first version's signal was the
  // weighting rather than the market.
  let dm = 0;
  for (const d of c.values()) dm += d.s / d.n;
  return { n: N, days, mean: xbar, dayMean: dm / days, t: xbar / se };
}

const rows: { key: string; n: number; days: number; mean: number; dayMean: number; t: number }[] = [];
for (const [key, c] of cells) {
  const st = tOf(c);
  if (!st || st.n < MIN_N || st.days < MIN_DAYS) continue;
  rows.push({ key, n: st.n, days: st.days, mean: st.mean, dayMean: st.dayMean, t: st.t });
}
rows.sort((a, b) => b.t - a.t);

const span = (books[0]!.cs[books[0]!.cs.length - 1]!.t - books[0]!.cs[0]!.t) / 86_400_000;
console.log(`${books.length} pairs · ${span.toFixed(0)} days · ${HOLD}h hold · ${(COST * 1e4).toFixed(0)}bp`);
console.log(`${PATS.length} patterns x ${CTX.length} contexts · ${rows.length} cells with n>=${MIN_N} over >=${MIN_DAYS} days`);
console.log(`${fires.toLocaleString()} pattern fires · baseline drift ${(BASE * 100).toFixed(3)}% per ${HOLD}h\n`);

// ---------------------------------------------------------------- the null
/**
 * Circularly shift each pair's forward returns while leaving the patterns where
 * they are. Pattern frequency, clustering and cross-pair correlation all survive;
 * only the pairing of pattern to outcome is destroyed. The largest |t| this
 * produces is the bar a real cell has to clear.
 */
const SHIFTS = [2160, 4320, 6480, 8640];
const nullMax: number[] = [];
const savedFwd = books.map((b) => b.fwd);
for (const sh of SHIFTS) {
  books.forEach((b, k) => { const L = savedFwd[k]!.length; b.fwd = savedFwd[k]!.map((_, i) => savedFwd[k]![(i + sh) % L]!); });
  const nc = new Map<string, Cell>();
  for (const b of books) {
    const ps = patterns(b);
    const hourOf = (t: number) => new Date(t).getUTCHours();
    for (let i = 205; i + HOLD < b.cs.length; i++) {
      if (!isFinite(b.atrA[i]!) || !(b.atrA[i]! > 0) || !isFinite(b.sma[i]!)) continue;
      const fwd = b.fwd[i]!;
      if (!isFinite(fwd)) continue;
      const c = b.cs[i]!;
      // Contexts are rebuilt identically, so the null is selected over all 791
      // cells exactly as the real pass is. Selecting from 791 and nulling over 65
      // would set the bar far too low.
      const bLo = breadth(sweepLo, c.t, b.sym), bHi = breadth(sweepHi, c.t, b.sym);
      const h = hourOf(c.t);
      const pos = (c.c - b.lo168[i]!) / Math.max(1e-12, b.hi168[i]! - b.lo168[i]!);
      const on: Ctx[] = ["all"];
      if (bLo >= 3) on.push("flushLo>=3");
      if (bLo >= 6) on.push("flushLo>=6");
      if (bHi >= 3) on.push("flushHi>=3");
      if (b.atrPct[i]! >= VHI) on.push("volHigh");
      if (b.atrPct[i]! <= VLO) on.push("volLow");
      on.push(c.c > b.sma[i]! ? "aboveSMA200" : "belowSMA200");
      if (pos <= 0.3) on.push("discount");
      if (pos >= 0.7) on.push("premium");
      if (h >= 13 && h < 21) on.push("NY"); else if (h >= 7 && h < 13) on.push("LDN"); else on.push("ASIA");
      const day = Math.floor(c.t / 86_400_000);
      for (const p of ps) {
        if (!p.fn(i)) continue;
        const ex = (p.side === "long" ? fwd - BASE : -(fwd - BASE)) - COST;
        for (const ctx of on) {
          const key = `${p.name}|${ctx}`;
          let cc = nc.get(key); if (!cc) { cc = new Map(); nc.set(key, cc); }
          const d = cc.get(day); if (d) { d.s += ex; d.n++; } else cc.set(day, { s: ex, n: 1 });
        }
      }
    }
  }
  let mx = 0;
  for (const c of nc.values()) { const st = tOf(c); if (st && st.n >= MIN_N && st.days >= MIN_DAYS) mx = Math.max(mx, Math.abs(st.t)); }
  nullMax.push(mx);
}
books.forEach((b, k) => { b.fwd = savedFwd[k]!; });
const NULLBAR = Math.max(...nullMax);
console.log(`NULL — shifted forward returns, max |t| over all ${rows.length} cells: ${nullMax.map((x) => x.toFixed(2)).join(", ")}`);
console.log(`       bar to clear: |t| > ${NULLBAR.toFixed(2)}\n`);

const pc = (x: number) => ((x * 100 >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%").padStart(8);
console.log("TOP CELLS by day-clustered t");
console.log("pattern           context          n    days    pooled  (dayMean)      t");
console.log("─".repeat(74));
for (const r of rows.slice(0, 30)) {
  const [p, c] = r.key.split("|");
  console.log(`${p!.padEnd(17)}${c!.padEnd(14)}${String(r.n).padStart(6)}${String(r.days).padStart(6)}  ` +
    `${pc(r.mean)} ${pc(r.dayMean)}  ${r.t.toFixed(2).padStart(6)}` +
    `${r.t > NULLBAR && r.mean > 0 ? "  *** clears the null, net positive" : r.t > NULLBAR ? "  (clears null, net negative)" : ""}`);
}
/**
 * A reliably losing short is a candidate long, but only if reversing it clears the
 * fee TWICE: the short's measured excess already has one cost subtracted, so the
 * flipped long is worth -(dayMean + COST) - COST. Printing that removes the
 * temptation to read a big negative t as a big positive opportunity.
 */
console.log("\nWORST CELLS — and what the FLIP is actually worth after paying the fee again");
console.log("pattern           context          n    days    pooled        t    flip net");
for (const r of rows.slice(-10)) {
  const [p, c] = r.key.split("|");
  const flip = -r.mean - 2 * COST;
  console.log(`${p!.padEnd(17)}${c!.padEnd(14)}${String(r.n).padStart(6)}${String(r.days).padStart(6)}  ` +
    `${pc(r.mean)}  ${r.t.toFixed(2).padStart(6)}   ${pc(flip)}${flip > 0 ? "  <-- tradeable" : ""}`);
}

/**
 * THE COMMON DENOMINATOR TEST.
 *
 * One pattern beating the null could be luck that the null under-measures. A
 * CONTEXT that lifts many unrelated patterns at once is a market fact. So: for
 * each context, how does the average pattern fare inside it versus in "all"?
 */
console.log("\nCONTEXT LIFT — mean of (cell mean - that pattern's 'all' mean), over patterns");
console.log("context          patterns   avg lift   better   median t");
const allByPat = new Map<string, number>();
for (const r of rows) { const [p, c] = r.key.split("|"); if (c === "all") allByPat.set(p!, r.mean); }
const lift: { ctx: string; k: number; avg: number; better: number; medT: number }[] = [];
for (const ctx of CTX) {
  if (ctx === "all") continue;
  const ds: number[] = [], ts: number[] = [];
  for (const r of rows) {
    const [p, c] = r.key.split("|");
    if (c !== ctx) continue;
    const base = allByPat.get(p!);
    if (base === undefined) continue;
    ds.push(r.mean - base); ts.push(r.t);
  }
  if (ds.length < 5) continue;
  ts.sort((a, b) => a - b);
  lift.push({ ctx, k: ds.length, avg: ds.reduce((a, b) => a + b, 0) / ds.length,
    better: ds.filter((x) => x > 0).length / ds.length, medT: ts[Math.floor(ts.length / 2)]! });
}
lift.sort((a, b) => b.avg - a.avg);
for (const l of lift) {
  console.log(`${l.ctx.padEnd(16)}${String(l.k).padStart(8)}   ${((l.avg * 100 >= 0 ? "+" : "") + (l.avg * 100).toFixed(3) + "%").padStart(8)}   ` +
    `${(l.better * 100).toFixed(0).padStart(4)}%   ${l.medT.toFixed(2).padStart(6)}`);
}
