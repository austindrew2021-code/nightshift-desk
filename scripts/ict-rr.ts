/**
 * The two untested structural levers.
 *
 *   npm run rr:ict
 *
 * 1. R:R. Flattening 100% at 1R makes the payoff 1:1, so breakeven is ~52% win.
 *    The A+ filter reaches 57% at 1R. Nobody has measured what it does at 2R or
 *    3R, where a LOWER win rate can still be a much better expectancy:
 *    40% at 2R is +0.20R, which beats 57% at 1R. Flatten-at-1R was adopted after
 *    one TAO wick, never measured against the alternative.
 *
 * 2. Timeframe. Cost is a fixed 14bp per round trip, so it costs 0.29R against a
 *    0.48% stop and 0.07R against a 2% stop. Wider stops on higher timeframes pay
 *    proportionally less toll for the same structure.
 *
 * Causal throughout, train/holdout, costs charged.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, atr, isLondon, isNyAm, isSilver, isNyPm, isAsia, htfBias } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = join(process.env.TMPDIR ?? "/tmp", `nightshift-bt-15m-${process.argv[2] ?? "175"}`);
const COST_BP = (5 + 2) * 2;

/** Resample 15m to a coarser bar by folding N bars. */
function fold(cs: Candle[], n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + n <= cs.length; i += n) {
    const g = cs.slice(i, i + n);
    out.push({
      t: g[0]!.t, o: g[0]!.o, c: g[g.length - 1]!.c,
      h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)),
      v: g.reduce((s, x) => s + (x.v || 0), 0),
    });
  }
  return out;
}

interface Raid { t: number; i: number; entry: number; bodyStop: number; neck: number }

/** A+ only: double top + closed below neckline + displacement >= 1 ATR + killzone + HTF down. */
function findAplus(cs: Candle[]): Raid[] {
  const out: Raid[] = [];
  const hi: number[] = [], lo: number[] = [];
  for (let k = 2; k < cs.length - 2; k++) {
    const c = cs[k]!;
    if (c.h > cs[k-1]!.h && c.h > cs[k-2]!.h && c.h > cs[k+1]!.h && c.h > cs[k+2]!.h) hi.push(k);
    if (c.l < cs[k-1]!.l && c.l < cs[k-2]!.l && c.l < cs[k+1]!.l && c.l < cs[k+2]!.l) lo.push(k);
  }
  for (let i = 60; i < cs.length - 1; i++) {
    const c = cs[i]!;
    const a = atr(cs, i);
    if (!(a > 0) || c.c >= c.o) continue;
    const kz = isLondon(c.t) || isNyAm(c.t) || isSilver(c.t) || isNyPm(c.t) || isAsia(c.t);
    if (!kz || htfBias(cs, i) !== -1) continue;
    if (Math.abs(c.c - c.o) < a) continue;                       // displacement
    const seen = hi.filter((j) => j + 2 <= i && j >= i - 80);
    if (seen.length < 2) continue;
    const j2 = seen[seen.length - 1]!, j1 = seen[seen.length - 2]!;
    if (i - j2 > 6) continue;
    const H1 = cs[j1]!.h, H2 = cs[j2]!.h;
    if (Math.abs(H2 - H1) > a * 0.4) continue;
    if (!(cs[j2]!.c < H1 && H2 > H1)) continue;                  // wick-only
    const mids = lo.filter((k) => k > j1 && k < j2);
    const neck = mids.length ? Math.min(...mids.map((k) => cs[k]!.l)) : Math.min(cs[j1]!.l, cs[j2]!.l);
    if (c.c >= neck) continue;                                    // neckline break
    out.push({ t: c.t, i, entry: c.c, bodyStop: Math.max(cs[j1]!.c, cs[j2]!.c) + a * 0.25, neck: Math.max(H1, H2) - neck });
  }
  return out;
}

/** Resolve to a target of `rr` R, or the measured move when rr is null. */
function resolve(cs: Candle[], r: Raid, rr: number | null, holdBars: number) {
  const dist = r.bodyStop - r.entry;
  if (!(dist > 0)) return null;
  const stopPct = dist / r.entry;
  if (stopPct > 0.05) return null;
  const target = rr === null ? r.entry - r.neck : r.entry - rr * dist;
  if (!(target < r.entry)) return null;
  const costR = (COST_BP / 10_000) / stopPct;
  for (let k = r.i + 1; k < Math.min(cs.length, r.i + holdBars); k++) {
    const c = cs[k]!;
    if (c.h >= r.bodyStop) return { r: -1 - costR, stopPct };     // stop first: conservative
    if (c.l <= target) return { r: (r.entry - target) / dist - costR, stopPct };
  }
  const last = cs[Math.min(cs.length - 1, r.i + holdBars)]!;
  return { r: (r.entry - last.c) / dist - costR, stopPct };
}

const raw: { sym: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 200) raw.push({ sym: a.symbol, cs });
}
if (!raw.length) { console.log(`no cache at ${CACHE}`); process.exit(1); }

function score(rows: { r: number; stopPct: number }[]) {
  const n = rows.length;
  if (n < 8) return null;
  const avg = rows.reduce((s, x) => s + x.r, 0) / n;
  const sd = Math.sqrt(rows.reduce((s, x) => s + (x.r - avg) ** 2, 0) / n) || 1;
  const med = [...rows.map((x) => x.stopPct)].sort((a, b) => a - b)[Math.floor(n / 2)]!;
  return { n, win: rows.filter((x) => x.r > 0).length / n, avg, t: (avg / sd) * Math.sqrt(n), med };
}

const TFS = [
  { label: "15m", fold: 1, hold: 96 },
  { label: "1H ", fold: 4, hold: 48 },
  { label: "4H ", fold: 16, hold: 30 },
];
const TARGETS: { label: string; rr: number | null }[] = [
  { label: "1R (current)", rr: 1 },
  { label: "1.5R", rr: 1.5 },
  { label: "2R", rr: 2 },
  { label: "3R", rr: 3 },
  { label: "measured move", rr: null },
];

console.log(`A+ raid shorts · causal · ${COST_BP}bp round trip · train/holdout 60/40\n`);
for (const tf of TFS) {
  const books = raw.map((b) => ({ sym: b.sym, cs: tf.fold === 1 ? b.cs : fold(b.cs, tf.fold) }));
  const found = books.flatMap((b) => findAplus(b.cs).map((r) => ({ b, r })));
  if (found.length < 20) { console.log(`${tf.label}: only ${found.length} A+ events, skipping\n`); continue; }
  const t0 = Math.min(...found.map((x) => x.r.t)), t1 = Math.max(...found.map((x) => x.r.t));
  const cut = t0 + (t1 - t0) * 0.6;
  console.log(`${tf.label}  ${found.length} A+ events  (${((t1-t0)/86_400_000).toFixed(0)} days)`);
  console.log(`      target          TRAIN                    HOLDOUT                 medStop`);
  for (const tg of TARGETS) {
    const rows = found.map((x) => ({ t: x.r.t, res: resolve(x.b.cs, x.r, tg.rr, tf.hold) })).filter((x) => x.res);
    const tr = score(rows.filter((x) => x.t < cut).map((x) => x.res!));
    const ho = score(rows.filter((x) => x.t >= cut).map((x) => x.res!));
    if (!tr || !ho) { console.log(`      ${tg.label.padEnd(15)} too few`); continue; }
    const mark = ho.avg > 0 ? (ho.t > 1.5 ? "  <<< POSITIVE, t>1.5" : "  <- positive") : "";
    console.log(
      `      ${tg.label.padEnd(15)}${String(tr.n).padStart(4)} ${(tr.win*100).toFixed(0).padStart(3)}% ${(tr.avg>=0?"+":"")}${tr.avg.toFixed(3)}` +
      `      ${String(ho.n).padStart(4)} ${(ho.win*100).toFixed(0).padStart(3)}% ${(ho.avg>=0?"+":"")}${ho.avg.toFixed(3)} t ${ho.t.toFixed(1).padStart(5)}` +
      `   ${(ho.med*100).toFixed(2)}%${mark}`,
    );
  }
  console.log();
}
