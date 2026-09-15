/**
 * Does sweeping a low actually lead to a pump — and what confirms it?
 *
 *   npm run rev:ict
 *
 * This measures the PHENOMENON, not a trade. No stops, no targets, no fees: just
 * the forward return after an event, at several horizons, against the
 * unconditional baseline over the same bars.
 *
 * The baseline matters more than anything else here. Crypto rose over these three
 * years, so "buy the sweep and it goes up" is trivially true and says nothing. The
 * only meaningful number is EXCESS over the unconditional mean — how much better
 * than buying at a random moment.
 *
 * Events: sweeps of the prior day / week / month low (and high, for symmetry).
 * Conditioners: volume spike, lower-wick ratio, RSI level, RSI divergence,
 * consecutive down bars, depth of the sweep, ATR expansion, hour of day.
 *
 * Ranked by t-stat with a Bonferroni bar, because this is many tests again.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, atr, rsiWilder, nyParts } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = "/tmp/nightshift-1h-3y";
const HORIZONS = [1, 4, 12, 24, 72, 168];   // hours

const books: { sym: string; cs: Candle[]; rsi: number[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 8000) books.push({ sym: a.symbol, cs, rsi: rsiWilder(cs, 14) });
}
if (!books.length) { console.log(`no cache at ${CACHE}`); process.exit(1); }

/** Prior-period extremes at each bar, computed causally. */
function priorExtremes(cs: Candle[]) {
  const dayKey = cs.map((c) => nyParts(c.t).day);
  const out = cs.map(() => ({ pdl: NaN, pdh: NaN, pwl: NaN, pwh: NaN, pml: NaN, pmh: NaN }));
  // rolling windows: 24h day, 168h week, 720h month, all ending BEFORE the bar
  const roll = (n: number, pick: "h" | "l") => {
    const res = new Array<number>(cs.length).fill(NaN);
    for (let i = n; i < cs.length; i++) {
      let v = pick === "h" ? -Infinity : Infinity;
      for (let k = i - n; k < i; k++) v = pick === "h" ? Math.max(v, cs[k]!.h) : Math.min(v, cs[k]!.l);
      res[i] = v;
    }
    return res;
  };
  const d1l = roll(24, "l"), d1h = roll(24, "h");
  const w1l = roll(168, "l"), w1h = roll(168, "h");
  const m1l = roll(720, "l"), m1h = roll(720, "h");
  for (let i = 0; i < cs.length; i++) {
    out[i] = { pdl: d1l[i]!, pdh: d1h[i]!, pwl: w1l[i]!, pwh: w1h[i]!, pml: m1l[i]!, pmh: m1h[i]! };
  }
  void dayKey;
  return out;
}

interface Ev { t: number; fwd: number[]; vol: number; wick: number; rsi: number; depth: number; down: number; hour: number; expand: number }

function events(cs: Candle[], rsi: number[], kind: "dayLow" | "weekLow" | "monthLow" | "dayHigh" | "weekHigh" | "monthHigh"): Ev[] {
  const ex = priorExtremes(cs);
  const out: Ev[] = [];
  const maxH = Math.max(...HORIZONS);
  for (let i = 720; i < cs.length - maxH; i++) {
    const c = cs[i]!, e = ex[i]!;
    const lvl = kind === "dayLow" ? e.pdl : kind === "weekLow" ? e.pwl : kind === "monthLow" ? e.pml
      : kind === "dayHigh" ? e.pdh : kind === "weekHigh" ? e.pwh : e.pmh;
    if (!isFinite(lvl)) continue;
    const isLow = kind.endsWith("Low");
    const hit = isLow ? c.l <= lvl : c.h >= lvl;
    if (!hit) continue;
    const prev = cs[i - 1]!;
    const prevLvl = isLow ? (ex[i-1]!.pdl ?? NaN) : (ex[i-1]!.pdh ?? NaN);
    void prevLvl;
    if (isLow ? prev.l <= lvl : prev.h >= lvl) continue;   // first touch only
    const a = atr(cs, i);
    if (!(a > 0)) continue;
    const rng = Math.max(1e-9, c.h - c.l);
    const vol20 = cs.slice(i - 20, i).reduce((s, x) => s + (x.v || 0), 0) / 20;
    let down = 0;
    for (let k = i - 1; k >= i - 8 && (isLow ? cs[k]!.c < cs[k]!.o : cs[k]!.c > cs[k]!.o); k--) down++;
    // forward return, signed so a "pump after a low sweep" is positive
    const sign = isLow ? 1 : -1;
    const fwd = HORIZONS.map((h) => sign * ((cs[i + h]!.c - c.c) / c.c));
    out.push({
      t: c.t, fwd,
      vol: vol20 > 0 ? (c.v || 0) / vol20 : 1,
      wick: isLow ? (Math.min(c.o, c.c) - c.l) / rng : (c.h - Math.max(c.o, c.c)) / rng,
      rsi: rsi[i] ?? 50,
      depth: Math.abs(c.l - lvl) / a,
      down, hour: nyParts(c.t).h,
      expand: a / (atr(cs, i - 24) || a),
    });
  }
  return out;
}

/** Unconditional baseline: forward returns from every bar, same horizons. */
function baseline(cs: Candle[]): number[][] {
  const maxH = Math.max(...HORIZONS);
  const acc: number[][] = HORIZONS.map(() => []);
  for (let i = 720; i < cs.length - maxH; i += 7) {
    for (let j = 0; j < HORIZONS.length; j++) acc[j]!.push((cs[i + HORIZONS[j]!]!.c - cs[i]!.c) / cs[i]!.c);
  }
  return acc;
}

const base: number[][] = HORIZONS.map(() => []);
for (const b of books) { const bb = baseline(b.cs); for (let j = 0; j < HORIZONS.length; j++) base[j]!.push(...bb[j]!); }
const baseMean = base.map((x) => x.reduce((a, c) => a + c, 0) / x.length);

console.log(`${books.length} pairs · 1H · 3.08y`);
console.log(`unconditional baseline forward return (this is what must be beaten):`);
console.log(`  ` + HORIZONS.map((h, j) => `${h}h ${(baseMean[j]!*100>=0?"+":"")+(baseMean[j]!*100).toFixed(3)}%`).join("   "));
console.log();

/**
 * Excess over baseline. `flip` must match the event's sign convention: for HIGH
 * sweeps `fwd` was stored as -(raw return), so the baseline has to be negated too.
 * Subtracting an unflipped baseline from a flipped return double-counts the drift
 * and made every high-sweep row wrong in the first run.
 */
function excess(evs: Ev[], j: number, flip = false) {
  const n = evs.length;
  if (n < 40) return null;
  const b = flip ? -baseMean[j]! : baseMean[j]!;
  const xs = evs.map((e) => e.fwd[j]! - b);
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / n) || 1e-12;
  return { n, m, t: (m / sd) * Math.sqrt(n) };
}

const KINDS = ["dayLow", "weekLow", "monthLow", "dayHigh", "weekHigh", "monthHigh"] as const;
const cache = new Map<string, Ev[]>();
for (const k of KINDS) {
  const all: Ev[] = [];
  for (const b of books) all.push(...events(b.cs, b.rsi, k));
  cache.set(k, all.sort((a, b) => a.t - b.t));
}

console.log("EVENT ALONE — excess forward return over baseline (sign flipped so 'reversal' = positive)");
console.log("event         n      " + HORIZONS.map((h) => `${String(h)+"h"}`.padStart(9)).join("") + "   best t");
for (const k of KINDS) {
  const evs = cache.get(k)!;
  const isHigh = k.endsWith("High");
  const cells = HORIZONS.map((_, j) => {
    const s = excess(evs, j, isHigh);
    return s ? `${(s.m*100>=0?"+":"")+(s.m*100).toFixed(2)}%`.padStart(9) : "      n/a";
  });
  const ts = HORIZONS.map((_, j) => excess(evs, j, isHigh)?.t ?? 0);
  const bi = ts.reduce((bestI, v, i2) => Math.abs(v) > Math.abs(ts[bestI]!) ? i2 : bestI, 0);
  console.log(`${k.padEnd(12)} ${String(evs.length).padStart(5)}  ${cells.join("")}   ${ts[bi]!.toFixed(1).padStart(5)} @${HORIZONS[bi]}h`);
}

// ── conditioners on the low sweeps ──
const CONDS: { label: string; f: (e: Ev) => boolean }[] = [
  { label: "volume > 1.5x avg",    f: (e) => e.vol > 1.5 },
  { label: "volume > 2.5x avg",    f: (e) => e.vol > 2.5 },
  { label: "volume < 0.8x avg",    f: (e) => e.vol < 0.8 },
  { label: "lower wick > 40% bar", f: (e) => e.wick > 0.4 },
  { label: "lower wick > 60% bar", f: (e) => e.wick > 0.6 },
  { label: "RSI < 30",             f: (e) => e.rsi < 30 },
  { label: "RSI < 25",             f: (e) => e.rsi < 25 },
  { label: "RSI > 40",             f: (e) => e.rsi > 40 },
  { label: "shallow sweep <0.5atr",f: (e) => e.depth < 0.5 },
  { label: "deep sweep >1.5atr",   f: (e) => e.depth > 1.5 },
  { label: ">=3 down bars before", f: (e) => e.down >= 3 },
  { label: "vol expanding >1.3x",  f: (e) => e.expand > 1.3 },
  { label: "vol contracting <0.8x",f: (e) => e.expand < 0.8 },
  { label: "09-11 NY",             f: (e) => e.hour >= 9 && e.hour <= 11 },
  { label: "00-06 NY (Asia/Lon)",  f: (e) => e.hour < 6 },
  { label: "wick>40% AND vol>1.5", f: (e) => e.wick > 0.4 && e.vol > 1.5 },
  { label: "wick>40% AND RSI<30",  f: (e) => e.wick > 0.4 && e.rsi < 30 },
  { label: "RSI<30 AND vol>1.5",   f: (e) => e.rsi < 30 && e.vol > 1.5 },
  { label: "deep AND wick>40%",    f: (e) => e.depth > 1.5 && e.wick > 0.4 },
];
const nTests = KINDS.length * HORIZONS.length + 3 * CONDS.length * HORIZONS.length;
const BONF = 2.807 + 0.5 * Math.log(nTests / 50);
console.log(`\n~${nTests} tests -> Bonferroni bar |t| > ${BONF.toFixed(2)}  ( * = clears )`);
console.log(`NOTE: events overlap — two sweeps within a horizon share forward bars — so the`);
console.log(`full-sample t is optimistic. The train/val/hold columns are the real check.\n`);

// Split boundaries, so the conditioner table can be checked out of sample.
const evT = cache.get("weekLow")!.map((e) => e.t);
const T0 = Math.min(...evT), T1 = Math.max(...evT);
const CUT_V = T0 + (T1 - T0) * 0.5, CUT_H = T0 + (T1 - T0) * 0.75;

for (const k of ["dayLow", "weekLow", "monthLow"] as const) {
  console.log(`CONDITIONERS on ${k}`);
  const evs = cache.get(k)!;
  const rows = CONDS.map((cd) => {
    const sel = evs.filter((e) => cd.f(e));
    const best = HORIZONS.map((_, j) => excess(sel, j)).map((s, j) => ({ s, j }))
      .filter((x) => x.s).sort((a, b) => Math.abs(b.s!.t) - Math.abs(a.s!.t))[0];
    return best ? { label: cd.label, n: sel.length, m: best.s!.m, t: best.s!.t, h: HORIZONS[best.j]! } : null;
  }).filter(Boolean) as { label: string; n: number; m: number; t: number; h: number }[];
  rows.sort((a, b) => b.t - a.t);
  for (const r of rows.slice(0, 6)) {
    const cd = CONDS.find((c) => c.label === r.label)!;
    const hj = HORIZONS.indexOf(r.h);
    const sel = evs.filter((e) => cd.f(e));
    // Out-of-sample check on the same conditioner + horizon.
    const tr = excess(sel.filter((e) => e.t < CUT_V), hj);
    const va = excess(sel.filter((e) => e.t >= CUT_V && e.t < CUT_H), hj);
    const ho = excess(sel.filter((e) => e.t >= CUT_H), hj);
    const seg = (s: ReturnType<typeof excess>) => s ? `${(s.m*100>=0?"+":"")+(s.m*100).toFixed(2)}%` : "  n/a";
    const stable = tr && va && ho && tr.m > 0 && va.m > 0 && ho.m > 0;
    console.log(`  ${r.label.padEnd(24)} n=${String(r.n).padStart(5)} all ${(r.m*100>=0?"+":"")+(r.m*100).toFixed(2)}% @${r.h}h t ${r.t.toFixed(1).padStart(5)}` +
      `${r.t > BONF ? " *" : "  "} | train ${seg(tr)} val ${seg(va)} hold ${seg(ho)}${stable ? "  <<< POSITIVE ALL THREE" : ""}`);
  }
  const worst = rows[rows.length - 1]!;
  console.log(`  (worst: ${worst.label} ${(worst.m*100).toFixed(2)}% t ${worst.t.toFixed(1)})`);
  console.log();
}
