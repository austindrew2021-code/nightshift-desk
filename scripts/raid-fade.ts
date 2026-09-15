/**
 * Fade the raid, or follow it? A direct head-to-head.
 *
 *   npm run fade:ict
 *
 * Board row 52 measured that raiding a prior extreme is a CHOP signature: only
 * 17.9% of big up days had first raided the prior low, while 74.7% of FLAT days
 * raided an extreme. If a raid mostly precedes a day that ends near where it
 * started, the implied trade is not continuation — it is a fade back to the mean.
 *
 * So both are tested on identical triggers, same bars, same costs:
 *   FADE         raid of PDH -> short back toward the mean
 *   CONTINUATION raid of PDH -> long, expecting the breakout to run
 * mirrored for PDL. The trigger is the first touch of the prior extreme; entry is
 * that bar's close, which is a price that existed.
 *
 * Targets tested, because "the mean" has several reasonable definitions:
 *   open   - today's NY open
 *   pdmid  - midpoint of the prior day's range
 *   half   - 50% retrace of the excursion beyond the extreme
 *
 * Stop is beyond the raid extreme by an ATR pad. Resolved intraday, then at the
 * day's close if neither level is hit. 1H bars, 1,125 days, 9 pairs, 14bp round
 * trip. Split by date into train / validation / holdout.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, atr, nyParts } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = "/tmp/nightshift-1h-3y";
const COST_BP = (5 + 2) * 2;

const books: { sym: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 8000) books.push({ sym: a.symbol, cs });
}
if (!books.length) { console.log(`no cache at ${CACHE}`); process.exit(1); }

interface Trade { t: number; r: number; gross: number; stopPct: number; hour: number; side: "long" | "short" }

function nyDays(cs: Candle[]) {
  const m = new Map<string, Candle[]>();
  for (let i = 0; i < cs.length; i++) {
    const k = nyParts(cs[i]!.t).day;
    const a = m.get(k); if (a) a.push(cs[i]!); else m.set(k, [cs[i]!]);
  }
  return [...m.entries()].filter(([, b]) => b.length >= 20)
    .map(([key, bars]) => ({ key, bars: bars.sort((x, y) => x.t - y.t) }))
    .sort((a, b) => a.bars[0]!.t - b.bars[0]!.t);
}

/** Global index of each candle, so ATR can be computed on the full series. */
function run(mode: "fade" | "cont", target: "open" | "pdmid" | "half", padAtr: number,
            hourFilter: ((h: number) => boolean) | null): Trade[] {
  const out: Trade[] = [];
  for (const b of books) {
    const idx = new Map<number, number>();
    for (let i = 0; i < b.cs.length; i++) idx.set(b.cs[i]!.t, i);
    const ds = nyDays(b.cs);
    for (let d = 1; d < ds.length; d++) {
      const prev = ds[d - 1]!, cur = ds[d]!;
      const pdh = Math.max(...prev.bars.map((c) => c.h));
      const pdl = Math.min(...prev.bars.map((c) => c.l));
      const pdmid = (pdh + pdl) / 2;
      const dayOpen = cur.bars[0]!.o;
      let done = false;
      for (let k = 0; k < cur.bars.length && !done; k++) {
        const c = cur.bars[k]!;
        const hr = nyParts(c.t).h;
        const gi = idx.get(c.t)!;
        const a = atr(b.cs, gi);
        if (!(a > 0)) continue;
        const hitH = c.h >= pdh, hitL = c.l <= pdl;
        if (!hitH && !hitL) continue;
        if (hourFilter && !hourFilter(hr)) { done = true; continue; }  // trigger consumed
        // one trade per day, on whichever side went first
        const raidHigh = hitH && (!hitL || c.c < c.o);
        const entry = c.c;
        // FADE goes against the raid; CONTINUATION goes with it.
        const side: "long" | "short" = raidHigh ? (mode === "fade" ? "short" : "long")
                                                : (mode === "fade" ? "long" : "short");
        const ext = raidHigh ? Math.max(c.h, pdh) : Math.min(c.l, pdl);
        const stop = raidHigh
          ? (side === "short" ? ext + a * padAtr : entry - a * padAtr)
          : (side === "long" ? ext - a * padAtr : entry + a * padAtr);
        let tgt: number;
        if (target === "open") tgt = dayOpen;
        else if (target === "pdmid") tgt = pdmid;
        else tgt = raidHigh ? ext - (ext - dayOpen) * 0.5 : ext + (dayOpen - ext) * 0.5;
        // continuation targets must sit beyond the raid, not back at the mean
        if (mode === "cont") {
          const dist = Math.abs(entry - stop);
          tgt = side === "long" ? entry + dist * 2 : entry - dist * 2;
        }
        const dist = Math.abs(entry - stop);
        if (!(dist > 0)) { done = true; continue; }
        const stopPct = dist / entry;
        if (stopPct > 0.06) { done = true; continue; }
        const good = side === "long" ? tgt > entry : tgt < entry;
        if (!good) { done = true; continue; }
        const costR = (COST_BP / 10_000) / stopPct;
        let g: number | null = null;
        for (let j = k + 1; j < cur.bars.length; j++) {
          const x = cur.bars[j]!;
          if (side === "long") {
            if (x.l <= stop) { g = -1; break; }                  // stop first: conservative
            if (x.h >= tgt) { g = (tgt - entry) / dist; break; }
          } else {
            if (x.h >= stop) { g = -1; break; }
            if (x.l <= tgt) { g = (entry - tgt) / dist; break; }
          }
        }
        if (g === null) {
          const last = cur.bars[cur.bars.length - 1]!.c;
          g = (side === "long" ? last - entry : entry - last) / dist;
        }
        out.push({ t: c.t, r: g - costR, gross: g, stopPct, hour: hr, side });
        done = true;
      }
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

function stat(rows: Trade[]) {
  const n = rows.length;
  if (n < 30) return null;
  const m = rows.reduce((s, x) => s + x.r, 0) / n;
  const sd = Math.sqrt(rows.reduce((s, x) => s + (x.r - m) ** 2, 0) / n) || 1e-9;
  const gm = rows.reduce((s, x) => s + x.gross, 0) / n;
  const medStop = [...rows.map((x) => x.stopPct)].sort((a, b) => a - b)[Math.floor(n / 2)]!;
  return { n, win: rows.filter((x) => x.r > 0).length / n, avgR: m, gross: gm,
    cost: gm - m, medStop, t: (m / sd) * Math.sqrt(n) };
}

const allT = books.flatMap((b) => [b.cs[0]!.t, b.cs[b.cs.length - 1]!.t]);
const t0 = Math.min(...allT), t1 = Math.max(...allT);
const cutV = t0 + (t1 - t0) * 0.5, cutH = t0 + (t1 - t0) * 0.75;

console.log(`${books.length} pairs · 1H · ${((t1-t0)/86_400_000).toFixed(0)} days · ${COST_BP}bp round trip`);
console.log(`train <50% · validation 50-75% · holdout last 25%\n`);
console.log("mode  target  pad   TRAIN                    VALIDATION               HOLDOUT");
console.log("                      n  win   avgR            n  win   avgR            n  win   avgR     t");
console.log("─".repeat(104));

const rows: { label: string; v: number; all: Trade[] }[] = [];
for (const mode of ["fade", "cont"] as const) {
  for (const target of ["open", "pdmid", "half"] as const) {
    if (mode === "cont" && target !== "open") continue;   // continuation uses 2R, target irrelevant
    for (const pad of [0.25, 0.5, 1.0]) {
      const all = run(mode, target, pad, null);
      const tr = stat(all.filter((x) => x.t < cutV));
      const v = stat(all.filter((x) => x.t >= cutV && x.t < cutH));
      const h = stat(all.filter((x) => x.t >= cutH));
      if (!tr || !v || !h) continue;
      const f = (s: NonNullable<ReturnType<typeof stat>>) =>
        `${String(s.n).padStart(5)} ${(s.win*100).toFixed(0).padStart(3)}% ${(s.avgR>=0?"+":"")+s.avgR.toFixed(3)}`;
      console.log(`${mode.padEnd(5)} ${target.padEnd(7)} ${pad.toFixed(2)}  ${f(tr)}      ${f(v)}      ${f(h)} ${h.t.toFixed(1).padStart(5)}`);
      rows.push({ label: `${mode} ${target} pad${pad}`, v: v.avgR, all });
    }
  }
}

// Does the 9-11am NY concentration from row 52 improve the fade?
console.log(`\nFADE restricted to the 09:00-11:00 NY window (row 52's liquidity cluster):`);
for (const target of ["open", "pdmid"] as const) {
  const all = run("fade", target, 0.5, (h) => h >= 9 && h <= 11);
  const tr = stat(all.filter((x) => x.t < cutV)), v = stat(all.filter((x) => x.t >= cutV && x.t < cutH));
  const h = stat(all.filter((x) => x.t >= cutH));
  if (!tr || !v || !h) { console.log(`  ${target}: too few`); continue; }
  console.log(`  ${target.padEnd(6)} train ${(tr.avgR>=0?"+":"")+tr.avgR.toFixed(3)}  val ${(v.avgR>=0?"+":"")+v.avgR.toFixed(3)}` +
    `  HOLDOUT n=${h.n} win ${(h.win*100).toFixed(0)}%` +
    `  GROSS ${(h.gross>=0?"+":"")+h.gross.toFixed(3)}R  cost -${h.cost.toFixed(3)}R  NET ${(h.avgR>=0?"+":"")+h.avgR.toFixed(3)}R` +
    `  t ${h.t.toFixed(1)}  medStop ${(h.medStop*100).toFixed(2)}%`);
}

// Cost in R is 14bp / stopWidth, so a wider stop mechanically cuts the toll.
// The 09:00-11:00 fade has gross +0.142R against a 0.198R cost on a 0.83% stop.
// Widening trades R-per-win for a lower toll and a higher win rate; which wins is
// an empirical question, so sweep it.
console.log(`\nSTOP WIDTH SWEEP — fade, pdmid target, 09:00-11:00 NY only`);
console.log(`  pad    medStop   GROSS R by period            HOLDOUT`);
console.log(`                    train    val   holdout   cost     net      t`);
for (const pad of [1.0, 1.5, 2.0, 3.0, 4.0]) {
  const all = run("fade", "pdmid", pad, (h) => h >= 9 && h <= 11);
  const tr = stat(all.filter((x) => x.t < cutV));
  const v = stat(all.filter((x) => x.t >= cutV && x.t < cutH));
  const h = stat(all.filter((x) => x.t >= cutH));
  if (!tr || !v || !h) { console.log(`  ${pad.toFixed(1)}  too few`); continue; }
  // GROSS on every split, not just holdout. A net-positive holdout means nothing
  // if the gross edge changed SIGN between periods — that is a period effect, not
  // an edge, and it is the single easiest way to fool yourself here.
  const flip = tr.gross < 0 && h.gross > 0;
  const mark = tr.gross > 0 && v.gross > 0 && h.gross > 0
    ? "  <<< gross positive in ALL THREE"
    : flip ? "  <- gross FLIPPED sign: period effect, not edge" : "";
  console.log(`  ${pad.toFixed(1)}    ${(h.medStop*100).toFixed(2)}%  ` +
    `${(tr.gross>=0?"+":"")+tr.gross.toFixed(3)}  ${(v.gross>=0?"+":"")+v.gross.toFixed(3)}  ` +
    `${(h.gross>=0?"+":"")+h.gross.toFixed(3)} -${h.cost.toFixed(3)} ${(h.avgR>=0?"+":"")+h.avgR.toFixed(3)} ${h.t.toFixed(1).padStart(5)}${mark}`);
}

// What fee tier turns the gross edge into a net one?
console.log(`\nFEE SENSITIVITY on the best gross config (fade pdmid 09-11, pad 1.0):`);
const bestAll = run("fade", "pdmid", 1.0, (h) => h >= 9 && h <= 11);
const bh = stat(bestAll.filter((x) => x.t >= cutH))!;
for (const [lbl, bp] of [["retail taker 5bp/side", 14], ["maker 2bp/side", 8], ["maker rebate ~0.5bp", 3], ["zero fees", 0]] as const) {
  const cost = (bp / 10_000) / bh.medStop;
  const net = bh.gross - cost;
  console.log(`  ${lbl.padEnd(24)} ${String(bp).padStart(2)}bp -> cost ${cost.toFixed(3)}R  NET ${(net>=0?"+":"")+net.toFixed(3)}R${net > 0 ? "  <- positive" : ""}`);
}

const best = rows.filter((r) => r.v > 0).sort((a, b) => b.v - a.v)[0];
if (best) {
  const h = stat(best.all.filter((x) => x.t >= cutH))!;
  console.log(`\nBest on validation: ${best.label}`);
  console.log(`  by trigger side on holdout:`);
  for (const side of ["long", "short"] as const) {
    const s = stat(best.all.filter((x) => x.t >= cutH && x.side === side));
    if (s) console.log(`    ${side.padEnd(5)} n=${s.n} win ${(s.win*100).toFixed(0)}% avgR ${(s.avgR>=0?"+":"")+s.avgR.toFixed(3)} t ${s.t.toFixed(1)}`);
  }
  console.log(`  combined holdout: n=${h.n} win ${(h.win*100).toFixed(0)}% avgR ${(h.avgR>=0?"+":"")+h.avgR.toFixed(3)} t ${h.t.toFixed(1)}`);
} else {
  console.log(`\nNo configuration was positive on validation.`);
}
