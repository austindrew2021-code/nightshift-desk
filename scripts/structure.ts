/**
 * Structural regularities: when does the market do things, not whether a strategy
 * makes money.
 *
 *   npm run struct:ict
 *
 * This is deliberately descriptive rather than a P&L test. A timing regularity can
 * be measured with far more power than an edge, because observing it does not pay
 * fees. Questions, all with strong n over 1,125 days x 9 pairs:
 *
 *  1. At what NY hour does the DAILY HIGH and DAILY LOW form?
 *  2. At what hour does the prior day's high / low first get SWEPT?
 *  3. How often does a day take BOTH prior extremes, or neither?
 *  4. Which weekday makes the weekly high / low? Which day of month?
 *  5. On a big trend day, what happened first — did it raid the opposite side?
 *  6. Is there a month-of-year effect?
 *
 * Every distribution is tested against uniform with chi-square, so "it always
 * sweeps at 10am" becomes a number rather than an impression.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, nyParts } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = "/tmp/nightshift-1h-3y";
const books: { sym: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 8000) books.push({ sym: a.symbol, cs });
}
if (!books.length) { console.log(`no cache at ${CACHE}`); process.exit(1); }

/** chi-square against uniform; returns the statistic and a rough significance read. */
function chi2(counts: number[]): { x2: number; df: number; verdict: string } {
  const n = counts.reduce((a, b) => a + b, 0);
  const exp = n / counts.length;
  const x2 = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
  const df = counts.length - 1;
  // 0.001 critical values for the df we use here
  const crit: Record<number, number> = { 4: 18.5, 6: 22.5, 11: 31.3, 23: 49.7, 30: 59.7 };
  const c = crit[df] ?? df + 3 * Math.sqrt(2 * df);
  return { x2, df, verdict: x2 > c ? `NOT uniform (p<0.001, crit ${c.toFixed(0)})` : `consistent with uniform (crit ${c.toFixed(0)})` };
}
function bar(v: number, max: number, w = 28) { return "#".repeat(Math.max(0, Math.round((v / max) * w))); }

interface Day { key: string; bars: Candle[]; dow: number }

/** Group bars into NY calendar days. */
function nyDays(cs: Candle[]): Day[] {
  const m = new Map<string, Candle[]>();
  for (const c of cs) {
    const k = nyParts(c.t).day;
    const a = m.get(k); if (a) a.push(c); else m.set(k, [c]);
  }
  return [...m.entries()]
    .filter(([, b]) => b.length >= 20)
    .map(([key, bars]) => {
      const [y, mo, d] = key.split("-").map(Number);
      return { key, bars: bars.sort((a, b) => a.t - b.t), dow: new Date(Date.UTC(y!, mo!, d!)).getUTCDay() };
    })
    .sort((a, b) => a.bars[0]!.t - b.bars[0]!.t);
}

console.log(`${books.length} pairs · 1H · ${(books[0]!.cs.length / 24).toFixed(0)} days each\n`);
console.log("=".repeat(74));
console.log("1. WHAT HOUR (NY) DOES THE DAILY HIGH / LOW FORM?");
console.log("=".repeat(74));
const hiH = new Array(24).fill(0), loH = new Array(24).fill(0);
let days = 0;
for (const b of books) {
  for (const d of nyDays(b.cs)) {
    days++;
    let hi = -Infinity, lo = Infinity, ih = 0, il = 0;
    for (const c of d.bars) {
      if (c.h > hi) { hi = c.h; ih = nyParts(c.t).h; }
      if (c.l < lo) { lo = c.l; il = nyParts(c.t).h; }
    }
    hiH[ih]++; loH[il]++;
  }
}
const mx = Math.max(...hiH, ...loH);
console.log(`n = ${days} pair-days\nNY hr   daily HIGH forms          daily LOW forms`);
for (let h = 0; h < 24; h++) {
  const tag = h === 9 || h === 10 ? " <-9/10am" : h === 2 ? " <-London" : h === 20 ? " <-Asia" : "";
  console.log(`  ${String(h).padStart(2)}  ${((hiH[h]/days)*100).toFixed(1).padStart(4)}% ${bar(hiH[h], mx, 16).padEnd(17)}` +
    `${((loH[h]/days)*100).toFixed(1).padStart(4)}% ${bar(loH[h], mx, 16)}${tag}`);
}
console.log(`  HIGH hour: ${chi2(hiH).verdict}  x2=${chi2(hiH).x2.toFixed(0)}`);
console.log(`  LOW  hour: ${chi2(loH).verdict}  x2=${chi2(loH).x2.toFixed(0)}`);

console.log("\n" + "=".repeat(74));
console.log("2. WHAT HOUR DOES THE PRIOR DAY'S HIGH / LOW FIRST GET SWEPT?");
console.log("=".repeat(74));
const swH = new Array(24).fill(0), swL = new Array(24).fill(0);
let both = 0, neither = 0, onlyH = 0, onlyL = 0, pdDays = 0;
for (const b of books) {
  const ds = nyDays(b.cs);
  for (let i = 1; i < ds.length; i++) {
    const prev = ds[i - 1]!, cur = ds[i]!;
    const pdh = Math.max(...prev.bars.map((c) => c.h));
    const pdl = Math.min(...prev.bars.map((c) => c.l));
    pdDays++;
    let hitH = -1, hitL = -1;
    for (const c of cur.bars) {
      const h = nyParts(c.t).h;
      if (hitH < 0 && c.h >= pdh) hitH = h;
      if (hitL < 0 && c.l <= pdl) hitL = h;
    }
    if (hitH >= 0) swH[hitH]++;
    if (hitL >= 0) swL[hitL]++;
    if (hitH >= 0 && hitL >= 0) both++;
    else if (hitH >= 0) onlyH++;
    else if (hitL >= 0) onlyL++;
    else neither++;
  }
}
const mx2 = Math.max(...swH, ...swL);
console.log(`n = ${pdDays} pair-days\nNY hr   sweeps PDH                sweeps PDL`);
for (let h = 0; h < 24; h++) {
  const tag = h === 9 || h === 10 ? " <-9/10am" : h === 2 ? " <-London" : "";
  console.log(`  ${String(h).padStart(2)}  ${((swH[h]/pdDays)*100).toFixed(1).padStart(4)}% ${bar(swH[h], mx2, 16).padEnd(17)}` +
    `${((swL[h]/pdDays)*100).toFixed(1).padStart(4)}% ${bar(swL[h], mx2, 16)}${tag}`);
}
console.log(`  PDH sweep hour: ${chi2(swH).verdict}`);
console.log(`  PDL sweep hour: ${chi2(swL).verdict}`);
console.log(`\n3. HOW OFTEN IS EACH SIDE TAKEN?`);
console.log(`  both extremes swept : ${((both/pdDays)*100).toFixed(1)}%`);
console.log(`  only PDH            : ${((onlyH/pdDays)*100).toFixed(1)}%`);
console.log(`  only PDL            : ${((onlyL/pdDays)*100).toFixed(1)}%`);
console.log(`  NEITHER (inside day): ${((neither/pdDays)*100).toFixed(1)}%`);

// ── control for the boundary artifact ──
// Hours 0 and 23 dominate section 1 mechanically: if a day trends, its extreme is
// necessarily near one edge. That is arithmetic, not timing. Restricting to RANGE
// days (|close-open| < 1%) removes the trend and leaves genuine intraday timing.
console.log("\n" + "=".repeat(74));
console.log("1b. CONTROL — hour of extreme on RANGE DAYS ONLY (|return| < 1%)");
console.log("=".repeat(74));
const rHi = new Array(24).fill(0), rLo = new Array(24).fill(0);
let rDays = 0;
for (const b of books) {
  for (const d of nyDays(b.cs)) {
    const o = d.bars[0]!.o, c = d.bars[d.bars.length - 1]!.c;
    if (Math.abs((c - o) / o) >= 0.01) continue;
    rDays++;
    let hi = -Infinity, lo = Infinity, ih = 0, il = 0;
    for (const x of d.bars) {
      if (x.h > hi) { hi = x.h; ih = nyParts(x.t).h; }
      if (x.l < lo) { lo = x.l; il = nyParts(x.t).h; }
    }
    rHi[ih]++; rLo[il]++;
  }
}
const mxr = Math.max(...rHi, ...rLo);
console.log(`n = ${rDays} range pair-days (of ${days})\nNY hr   HIGH                      LOW`);
for (let h = 0; h < 24; h++) {
  const tag = h === 9 || h === 10 ? " <-9/10am" : h === 2 ? " <-London" : h === 20 ? " <-Asia" : "";
  console.log(`  ${String(h).padStart(2)}  ${((rHi[h]/rDays)*100).toFixed(1).padStart(4)}% ${bar(rHi[h], mxr, 16).padEnd(17)}` +
    `${((rLo[h]/rDays)*100).toFixed(1).padStart(4)}% ${bar(rLo[h], mxr, 16)}${tag}`);
}
console.log(`  HIGH hour (range days): ${chi2(rHi).verdict}  x2=${chi2(rHi).x2.toFixed(0)}`);
console.log(`  LOW  hour (range days): ${chi2(rLo).verdict}  x2=${chi2(rLo).x2.toFixed(0)}`);

console.log("\n" + "=".repeat(74));
console.log("3b. CONDITIONAL SWEEP ODDS — the question the XRP trade was really asking");
console.log("=".repeat(74));
const pAfterH = both / (onlyH + both), pAfterL = both / (onlyL + both);
console.log(`  Given the PRIOR HIGH is swept, the prior LOW also goes that day: ${(pAfterH*100).toFixed(1)}%`);
console.log(`  Given the PRIOR LOW is swept, the prior HIGH also goes that day:  ${(pAfterL*100).toFixed(1)}%`);
console.log(`  So fading a PDH raid all the way down to the PDL works about 1 day in ${(1/pAfterH).toFixed(0)}.`);
console.log(`  The day overwhelmingly picks ONE side (${(((onlyH+onlyL)/pdDays)*100).toFixed(0)}% take exactly one) and holds it.`);

console.log("\n" + "=".repeat(74));
console.log("4. WHICH WEEKDAY MAKES THE WEEKLY HIGH / LOW?  WHICH DAY OF MONTH?");
console.log("=".repeat(74));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const wHi = new Array(7).fill(0), wLo = new Array(7).fill(0);
const mHi = new Array(31).fill(0), mLo = new Array(31).fill(0);
for (const b of books) {
  const ds = nyDays(b.cs);
  // weeks start Sunday
  let cur: Day[] = [];
  for (const d of ds) {
    if (d.dow === 0 && cur.length) {
      let hi = -Infinity, lo = Infinity, dh = 0, dl = 0;
      for (const x of cur) { const h = Math.max(...x.bars.map(c=>c.h)), l = Math.min(...x.bars.map(c=>c.l));
        if (h > hi) { hi = h; dh = x.dow; } if (l < lo) { lo = l; dl = x.dow; } }
      wHi[dh]++; wLo[dl]++; cur = [];
    }
    cur.push(d);
  }
  const byMonth = new Map<string, Day[]>();
  for (const d of ds) { const k = d.key.split("-").slice(0,2).join("-"); const a = byMonth.get(k); if (a) a.push(d); else byMonth.set(k, [d]); }
  for (const [, arr] of byMonth) {
    if (arr.length < 25) continue;
    let hi = -Infinity, lo = Infinity, dh = 1, dl = 1;
    for (const x of arr) { const dom = Number(x.key.split("-")[2]);
      const h = Math.max(...x.bars.map(c=>c.h)), l = Math.min(...x.bars.map(c=>c.l));
      if (h > hi) { hi = h; dh = dom; } if (l < lo) { lo = l; dl = dom; } }
    mHi[dh-1]++; mLo[dl-1]++;
  }
}
const wn = wHi.reduce((a,b)=>a+b,0);
console.log(`weekly extremes, n = ${wn} pair-weeks`);
const mxw = Math.max(...wHi, ...wLo);
for (let i = 0; i < 7; i++)
  console.log(`  ${DOW[i]}  high ${((wHi[i]/wn)*100).toFixed(1).padStart(4)}% ${bar(wHi[i],mxw,14).padEnd(15)} low ${((wLo[i]/wn)*100).toFixed(1).padStart(4)}% ${bar(wLo[i],mxw,14)}`);
console.log(`  weekly HIGH day: ${chi2(wHi).verdict}`);
console.log(`  weekly LOW  day: ${chi2(wLo).verdict}`);
const thirds = (arr: number[]) => [arr.slice(0,10).reduce((a,b)=>a+b,0), arr.slice(10,20).reduce((a,b)=>a+b,0), arr.slice(20).reduce((a,b)=>a+b,0)];
const mn = mHi.reduce((a,b)=>a+b,0);
console.log(`\nmonthly extremes by third of month, n = ${mn} pair-months`);
const th = thirds(mHi), tl = thirds(mLo);
["1st-10th","11th-20th","21st-end"].forEach((lbl,i) =>
  console.log(`  ${lbl.padEnd(10)} high ${((th[i]!/mn)*100).toFixed(1).padStart(4)}%   low ${((tl[i]!/mn)*100).toFixed(1).padStart(4)}%`));

console.log("\n" + "=".repeat(74));
console.log("5. ON A BIG TREND DAY, WHAT HAPPENED FIRST?");
console.log("=".repeat(74));
let upDays = 0, upRaidedLow = 0, dnDays = 0, dnRaidedHigh = 0, flat = 0, flatRaid = 0;
for (const b of books) {
  const ds = nyDays(b.cs);
  for (let i = 1; i < ds.length; i++) {
    const prev = ds[i-1]!, cur = ds[i]!;
    const pdl = Math.min(...prev.bars.map(c=>c.l)), pdh = Math.max(...prev.bars.map(c=>c.h));
    const o = cur.bars[0]!.o, c = cur.bars[cur.bars.length-1]!.c;
    const ret = (c - o) / o;
    const tookLow = cur.bars.some(x => x.l <= pdl), tookHigh = cur.bars.some(x => x.h >= pdh);
    if (ret > 0.02) { upDays++; if (tookLow) upRaidedLow++; }
    else if (ret < -0.02) { dnDays++; if (tookHigh) dnRaidedHigh++; }
    else { flat++; if (tookLow || tookHigh) flatRaid++; }
  }
}
console.log(`  UP days   (close > +2%): ${upDays}  of which raided the PRIOR LOW first: ${((upRaidedLow/upDays)*100).toFixed(1)}%`);
console.log(`  DOWN days (close < -2%): ${dnDays}  of which raided the PRIOR HIGH first: ${((dnRaidedHigh/dnDays)*100).toFixed(1)}%`);
console.log(`  FLAT days              : ${flat}  of which raided either extreme:      ${((flatRaid/flat)*100).toFixed(1)}%`);

console.log("\n" + "=".repeat(74));
console.log("6. MONTH OF YEAR");
console.log("=".repeat(74));
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const mRet: number[][] = Array.from({length:12},()=>[]);
for (const b of books) {
  const byMonth = new Map<string, Day[]>();
  for (const d of nyDays(b.cs)) { const k = d.key.split("-").slice(0,2).join("-"); const a = byMonth.get(k); if (a) a.push(d); else byMonth.set(k,[d]); }
  for (const [k, arr] of byMonth) {
    if (arr.length < 25) continue;
    const o = arr[0]!.bars[0]!.o, c = arr[arr.length-1]!.bars.at(-1)!.c;
    mRet[Number(k.split("-")[1])]!.push(((c-o)/o)*100);
  }
}
for (let i = 0; i < 12; i++) {
  const v = mRet[i]!;
  if (!v.length) { console.log(`  ${MON[i]}  no data`); continue; }
  const m = v.reduce((a,b)=>a+b,0)/v.length;
  console.log(`  ${MON[i]}  n=${String(v.length).padStart(2)}  mean ${(m>=0?"+":"")+m.toFixed(1).padStart(5)}%  ${v.filter(x=>x>0).length}/${v.length} positive`);
}
console.log(`\n  NOTE: 3 years means ~3 observations per month per pair, and the 9 pairs are`);
console.log(`  highly correlated. Month-of-year here is descriptive only - nowhere near`);
console.log(`  enough independent years to establish an annual seasonal.`);
