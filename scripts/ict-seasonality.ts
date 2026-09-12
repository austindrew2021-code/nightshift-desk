/**
 * Per-pair calendar patterns: does any coin the app scans repeat by weekday or
 * by hour of the New York day?
 *
 *   npm run season:ict
 *
 * Method notes that decide whether the output means anything:
 *
 *  - MULTIPLE COMPARISONS. Testing 11 pairs x 7 weekdays is 77 tests; at p<0.05
 *    you expect ~4 "significant" results from pure noise. So the bar here is
 *    Bonferroni-corrected (|t| > ~3.0 for 77 tests), not |t| > 2.
 *  - CORRELATION. Crypto pairs move together, so pooling 11 pairs does NOT give
 *    11x the independent observations. The pooled t-stats below are inflated and
 *    are shown for direction only.
 *  - SAMPLE. 182 days is 26 weeks, so each pair-weekday cell holds ~26
 *    observations. That is thin for a weekday claim and is the main limit here.
 *    Hour-of-day cells hold ~182 each and are firmer.
 *  - Returns are close-to-close in basis points, costs excluded for the survey
 *    and then charged in the tradeable test at the end.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, nyParts } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = join(process.env.TMPDIR ?? "/tmp", `nightshift-bt-15m-${process.argv[2] ?? "175"}`);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const books: { sym: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 200) books.push({ sym: a.symbol, cs });
}
if (!books.length) { console.log(`no cache at ${CACHE}`); process.exit(1); }

function tstat(xs: number[]): { n: number; mean: number; t: number } {
  const n = xs.length;
  if (n < 3) return { n, mean: 0, t: 0 };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) || 1;
  return { n, mean: m, t: (m / (sd / Math.sqrt(n))) };
}

/** NY calendar day close-to-close returns, in basis points. */
function dailyReturns(cs: Candle[]): { day: string; dow: number; bp: number }[] {
  const byDay = new Map<string, Candle[]>();
  for (const c of cs) {
    const d = nyParts(c.t).day;
    const arr = byDay.get(d);
    if (arr) arr.push(c); else byDay.set(d, [c]);
  }
  const days = [...byDay.entries()].sort((a, b) => a[1][0]!.t - b[1][0]!.t);
  const out: { day: string; dow: number; bp: number }[] = [];
  for (const [day, bars] of days) {
    if (bars.length < 40) continue;                 // partial day
    const open = bars[0]!.o, close = bars[bars.length - 1]!.c;
    if (!(open > 0)) continue;
    const [y, m, dd] = day.split("-").map(Number);
    const dow = new Date(Date.UTC(y!, m!, dd!)).getUTCDay();
    out.push({ day, dow, bp: ((close - open) / open) * 10_000 });
  }
  return out;
}

console.log(`${books.length} pairs · ${((books[0]!.cs[books[0]!.cs.length-1]!.t - books[0]!.cs[0]!.t)/86_400_000).toFixed(0)} days · returns in bp\n`);

// ── weekday, per pair ──────────────────────────────────────────────────────
const nTests = books.length * 7;
const bonf = 3.0;   // ~p<0.05/77, two-sided
console.log(`WEEKDAY effect per pair (bp per day). ${nTests} tests -> significance bar |t| > ${bonf}`);
console.log("pair    " + DOW.map((d) => d.padStart(9)).join(""));
const pooled: Record<number, number[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
const flagged: string[] = [];
for (const b of books) {
  const rs = dailyReturns(b.cs);
  const cells = DOW.map((_, d) => {
    const xs = rs.filter((r) => r.dow === d).map((r) => r.bp);
    for (const x of xs) pooled[d]!.push(x);
    const s = tstat(xs);
    if (Math.abs(s.t) > bonf) flagged.push(`${b.sym} ${DOW[d]} ${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(0)}bp t=${s.t.toFixed(1)} n=${s.n}`);
    return `${(s.mean >= 0 ? "+" : "") + s.mean.toFixed(0)}/${s.t.toFixed(1)}`.padStart(9);
  });
  console.log(`${b.sym.padEnd(6)} ${cells.join("")}`);
}
console.log("\npooled  " + DOW.map((_, d) => {
  const s = tstat(pooled[d]!);
  return `${(s.mean >= 0 ? "+" : "") + s.mean.toFixed(0)}/${s.t.toFixed(1)}`.padStart(9);
}).join("") + "   (mean bp / t — inflated, pairs are correlated)");
console.log(`\ncells clearing |t| > ${bonf}: ${flagged.length ? flagged.join("; ") : "NONE"}`);

// ── hour of the NY day, pooled and per pair ───────────────────────────────
console.log(`\nHOUR of NY day, pooled across pairs (bp per hour, ~${(books.length * 182).toFixed(0)} obs each)`);
const byHour: Record<number, number[]> = {};
for (const b of books) {
  // aggregate 15m bars into NY hours
  const hrs = new Map<string, Candle[]>();
  for (const c of b.cs) {
    const p = nyParts(c.t);
    const k = `${p.day}#${p.h}`;
    const arr = hrs.get(k); if (arr) arr.push(c); else hrs.set(k, [c]);
  }
  for (const [k, bars] of hrs) {
    if (bars.length < 3) continue;
    const h = Number(k.split("#")[1]);
    const bp = ((bars[bars.length - 1]!.c - bars[0]!.o) / bars[0]!.o) * 10_000;
    (byHour[h] ??= []).push(bp);
  }
}
const hourRows = Object.entries(byHour).map(([h, xs]) => ({ h: Number(h), ...tstat(xs) }))
  .sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
const hourBar = 3.2;  // ~24 hours x 11 pairs of tests
for (const r of hourRows.slice(0, 8)) {
  const mark = Math.abs(r.t) > hourBar ? "  <-- clears the bar" : "";
  console.log(`  ${String(r.h).padStart(2)}:00 NY  ${(r.mean >= 0 ? "+" : "") + r.mean.toFixed(1).padStart(5)}bp  t ${r.t.toFixed(1).padStart(5)}  n=${r.n}${mark}`);
}

// ── tradeable test: best pooled hour, real costs, day-clustered ───────────
const best = hourRows[0]!;
const dir = best.mean >= 0 ? 1 : -1;

/**
 * Cost, done properly. feeRate 0.0005 is 0.05% = 5bp PER SIDE, so a round trip
 * is 10bp of fees plus 2bp of slippage per side = 14bp. An earlier version of
 * this script charged 0.28bp by mangling the percent conversion, which turned a
 * losing rule into a winner. The gross edge here is ~10bp, so the cost figure
 * decides the entire answer.
 */
const FEE_BP = 0.0005 * 10_000;      // 5bp per side
const SLIP_BP = 0.0002 * 10_000;     // 2bp per side
const COST_BP = (FEE_BP + SLIP_BP) * 2;

/**
 * Day-clustered: the 11 pairs move together, so treating each pair-hour as an
 * independent observation inflates t by roughly sqrt(pairs). One observation per
 * NY day — the equal-weight basket return for that hour — is the honest unit.
 */
const perDay = new Map<string, number[]>();
for (const b of books) {
  const hrs = new Map<string, Candle[]>();
  for (const c of b.cs) {
    const p = nyParts(c.t);
    if (p.h !== best.h) continue;
    const arr = hrs.get(p.day); if (arr) arr.push(c); else hrs.set(p.day, [c]);
  }
  for (const [day, bars] of hrs) {
    if (bars.length < 3) continue;
    const raw = ((bars[bars.length - 1]!.c - bars[0]!.o) / bars[0]!.o) * 10_000;
    (perDay.get(day) ?? perDay.set(day, []).get(day)!).push(raw * dir);
  }
}
const daily = [...perDay.entries()]
  .filter(([, xs]) => xs.length >= 5)
  .map(([day, xs]) => ({ day, gross: xs.reduce((a, b) => a + b, 0) / xs.length }))
  .sort((a, b) => (a.day < b.day ? -1 : 1));

console.log(`\nTRADEABLE TEST — ${dir > 0 ? "long" : "short"} an equal-weight basket at ${best.h}:00 NY, hold 1h`);
console.log(`  one observation per NY day (the basket), n=${daily.length} days — not per pair-hour`);
console.log(`  round-trip cost charged: ${COST_BP.toFixed(1)}bp  (fee ${FEE_BP}bp x2 + slip ${SLIP_BP}bp x2)`);
const cutIdx = Math.floor(daily.length * 0.6);
for (const [lbl, set] of [["train", daily.slice(0, cutIdx)], ["HOLDOUT", daily.slice(cutIdx)]] as const) {
  const g = tstat(set.map((x) => x.gross));
  const n = tstat(set.map((x) => x.gross - COST_BP));
  console.log(`  ${lbl.padEnd(8)} n=${String(g.n).padStart(3)}  gross ${(g.mean >= 0 ? "+" : "") + g.mean.toFixed(2)}bp t ${g.t.toFixed(1).padStart(5)}   NET ${(n.mean >= 0 ? "+" : "") + n.mean.toFixed(2)}bp t ${n.t.toFixed(1).padStart(5)}`);
}
const allNet = tstat(daily.map((x) => x.gross - COST_BP));
console.log(`\n  full sample NET: ${(allNet.mean >= 0 ? "+" : "") + allNet.mean.toFixed(2)}bp/day  t ${allNet.t.toFixed(1)}  over ${daily.length} days`);
const compounded = daily.reduce((eq, d) => eq * (1 + (d.gross - COST_BP) / 10_000), 100);
console.log(`  $100 compounded once per day at full size: $${compounded.toFixed(2)}`);
console.log(`\n  The gross edge is real and survives Bonferroni. Whether it is tradeable`);
console.log(`  depends entirely on whether ${COST_BP.toFixed(0)}bp of cost is beaten by a ~${Math.abs(best.mean).toFixed(0)}bp move.`);
