/**
 * Maker-only limit entries, modelled honestly.
 *
 *   npm run maker:ict
 *
 * The naive version of this test — take the same trades and charge less — is
 * fantasy, and it is exactly what row 53's fee-sensitivity table would become if
 * read as a strategy. A limit order is not a cheaper market order. It introduces
 * two effects that work against you and one that works for you:
 *
 *   FOR:     lower fee (maker vs taker) AND a better entry price.
 *   AGAINST: it only fills if price comes back to the level. Many trades simply
 *            never happen, so the sample changes.
 *   AGAINST: ADVERSE SELECTION. Conditional on filling, you are more likely to be
 *            filled precisely when price is about to keep going against you —
 *            the fills you get are a worse draw than the fills you miss.
 *
 * So this models the limit explicitly: place it, require a later bar to trade
 * through it, and measure the realised fill rate and the outcome conditional on
 * filling. Then compare against the taker baseline on the SAME trigger set.
 *
 * Strategy under test is row 53's best: fade the raid, 09:00-11:00 NY, target the
 * prior-day midpoint.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, atr, nyParts } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = "/tmp/nightshift-1h-3y";
const TAKER_BP = 5, MAKER_BP = 2, SLIP_BP = 2;

const books: { sym: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 8000) books.push({ sym: a.symbol, cs });
}
if (!books.length) { console.log(`no cache at ${CACHE}`); process.exit(1); }

function nyDays(cs: Candle[]) {
  const m = new Map<string, Candle[]>();
  for (const c of cs) { const k = nyParts(c.t).day; const a = m.get(k); if (a) a.push(c); else m.set(k, [c]); }
  return [...m.entries()].filter(([, b]) => b.length >= 20)
    .map(([key, bars]) => ({ key, bars: bars.sort((x, y) => x.t - y.t) }))
    .sort((a, b) => a.bars[0]!.t - b.bars[0]!.t);
}

interface T { t: number; r: number; gross: number; stopPct: number; filled: boolean }

/**
 * entryMode:
 *   taker  - market at the signal bar's close, always fills, taker fee + slip
 *   maker  - limit at `offsetAtr` BETTER than the close; fills only if a later bar
 *            trades through it within `waitBars`; maker fee, no spread paid
 */
function run(entryMode: "taker" | "maker", offsetAtr: number, padAtr: number, waitBars: number): T[] {
  const out: T[] = [];
  for (const b of books) {
    const idx = new Map<number, number>();
    for (let i = 0; i < b.cs.length; i++) idx.set(b.cs[i]!.t, i);
    const ds = nyDays(b.cs);
    for (let d = 1; d < ds.length; d++) {
      const prev = ds[d - 1]!, cur = ds[d]!;
      const pdh = Math.max(...prev.bars.map((c) => c.h));
      const pdl = Math.min(...prev.bars.map((c) => c.l));
      const pdmid = (pdh + pdl) / 2;
      let done = false;
      for (let k = 0; k < cur.bars.length && !done; k++) {
        const c = cur.bars[k]!;
        const hr = nyParts(c.t).h;
        if (hr < 9 || hr > 11) continue;
        const a = atr(b.cs, idx.get(c.t)!);
        if (!(a > 0)) continue;
        const hitH = c.h >= pdh, hitL = c.l <= pdl;
        if (!hitH && !hitL) continue;
        done = true;
        const raidHigh = hitH && (!hitL || c.c < c.o);
        const side: "long" | "short" = raidHigh ? "short" : "long";
        const ext = raidHigh ? Math.max(c.h, pdh) : Math.min(c.l, pdl);

        // Entry
        let entry: number, filled = true, feeBp: number, startBar = k + 1;
        if (entryMode === "taker") {
          entry = c.c;
          feeBp = TAKER_BP + SLIP_BP;
        } else {
          // Resting limit placed BETTER than the close: for a short, above it.
          entry = raidHigh ? c.c + a * offsetAtr : c.c - a * offsetAtr;
          feeBp = MAKER_BP;                                  // no spread crossed
          filled = false;
          for (let j = k + 1; j < Math.min(cur.bars.length, k + 1 + waitBars); j++) {
            const x = cur.bars[j]!;
            if (raidHigh ? x.h >= entry : x.l <= entry) { filled = true; startBar = j + 1; break; }
          }
          if (!filled) { out.push({ t: c.t, r: 0, gross: 0, stopPct: 0, filled: false }); continue; }
        }

        const stop = raidHigh ? Math.max(ext, entry) + a * padAtr : Math.min(ext, entry) - a * padAtr;
        const dist = Math.abs(entry - stop);
        if (!(dist > 0)) continue;
        const stopPct = dist / entry;
        if (stopPct > 0.06) continue;
        const tgt = pdmid;
        if (side === "long" ? tgt <= entry : tgt >= entry) continue;
        // exit is a limit at the target (maker) but the stop is a market order
        const exitFeeBp = entryMode === "maker" ? MAKER_BP : TAKER_BP + SLIP_BP;
        const costR = ((feeBp + exitFeeBp) / 10_000) / stopPct;

        let g: number | null = null;
        for (let j = startBar; j < cur.bars.length; j++) {
          const x = cur.bars[j]!;
          if (side === "long") {
            if (x.l <= stop) { g = -1; break; }
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
        out.push({ t: c.t, r: g - costR, gross: g, stopPct, filled: true });
      }
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

function stat(rows: T[]) {
  const f = rows.filter((x) => x.filled);
  if (f.length < 30) return null;
  const n = f.length;
  const m = f.reduce((s, x) => s + x.r, 0) / n;
  const sd = Math.sqrt(f.reduce((s, x) => s + (x.r - m) ** 2, 0) / n) || 1e-9;
  const gm = f.reduce((s, x) => s + x.gross, 0) / n;
  return { n, triggers: rows.length, fillRate: n / rows.length,
    win: f.filter((x) => x.r > 0).length / n, net: m, gross: gm, cost: gm - m,
    t: (m / sd) * Math.sqrt(n),
    medStop: [...f.map((x) => x.stopPct)].sort((a, b) => a - b)[Math.floor(n / 2)]! };
}

const allT = books.flatMap((b) => [b.cs[0]!.t, b.cs[b.cs.length - 1]!.t]);
const t0 = Math.min(...allT), t1 = Math.max(...allT);
const cutV = t0 + (t1 - t0) * 0.5, cutH = t0 + (t1 - t0) * 0.75;

console.log(`${books.length} pairs · 1H · ${((t1-t0)/86_400_000).toFixed(0)} days`);
console.log(`taker ${TAKER_BP}bp + ${SLIP_BP}bp slip per side · maker ${MAKER_BP}bp per side, no spread`);
console.log(`strategy: fade the raid, 09:00-11:00 NY, target prior-day midpoint\n`);
console.log("entry             fill%  n     GROSS R by period          cost    net      t   medStop");
console.log("                              train    val   holdout");
console.log("─".repeat(94));

const cfgs: { label: string; mode: "taker" | "maker"; off: number; pad: number; wait: number }[] = [
  { label: "TAKER (baseline)",      mode: "taker", off: 0,    pad: 1.0, wait: 0 },
  { label: "maker +0.10 ATR",       mode: "maker", off: 0.10, pad: 1.0, wait: 4 },
  { label: "maker +0.25 ATR",       mode: "maker", off: 0.25, pad: 1.0, wait: 4 },
  { label: "maker +0.50 ATR",       mode: "maker", off: 0.50, pad: 1.0, wait: 4 },
  { label: "maker +0.25 wait 8",    mode: "maker", off: 0.25, pad: 1.0, wait: 8 },
  { label: "maker +0.25 pad 2.0",   mode: "maker", off: 0.25, pad: 2.0, wait: 4 },
  { label: "maker +0.50 pad 2.0",   mode: "maker", off: 0.50, pad: 2.0, wait: 4 },
];
for (const cf of cfgs) {
  const all = run(cf.mode, cf.off, cf.pad, cf.wait);
  const tr = stat(all.filter((x) => x.t < cutV));
  const v = stat(all.filter((x) => x.t >= cutV && x.t < cutH));
  const h = stat(all.filter((x) => x.t >= cutH));
  if (!tr || !v || !h) { console.log(`${cf.label.padEnd(18)} too few`); continue; }
  const flip = tr.gross < 0 && h.gross > 0;
  const mark = tr.gross > 0 && v.gross > 0 && h.gross > 0 ? "  <<< gross positive ALL THREE"
    : flip ? "  <- gross flips: period effect" : "";
  console.log(`${cf.label.padEnd(18)}${(h.fillRate*100).toFixed(0).padStart(4)}% ${String(h.n).padStart(4)}  ` +
    `${(tr.gross>=0?"+":"")+tr.gross.toFixed(3)} ${(v.gross>=0?"+":"")+v.gross.toFixed(3)} ` +
    `${(h.gross>=0?"+":"")+h.gross.toFixed(3)}  -${h.cost.toFixed(3)} ${(h.net>=0?"+":"")+h.net.toFixed(3)} ` +
    `${h.t.toFixed(1).padStart(5)}  ${(h.medStop*100).toFixed(2)}%${mark}`);
}

// Adverse selection: are the fills a worse draw than the misses would have been?
console.log(`\nADVERSE SELECTION CHECK — maker +0.25 ATR, holdout`);
const mk = run("maker", 0.25, 1.0, 4).filter((x) => x.t >= cutH);
const tk = run("taker", 0, 1.0, 0).filter((x) => x.t >= cutH);
const mkF = mk.filter((x) => x.filled);
console.log(`  triggers ${mk.length}   filled ${mkF.length} (${((mkF.length/mk.length)*100).toFixed(0)}%)   never filled ${mk.length - mkF.length}`);
const tkAll = stat(tk)!, mkAll = stat(mk)!;
console.log(`  taker gross on ALL triggers      ${(tkAll.gross>=0?"+":"")+tkAll.gross.toFixed(3)}R  (n=${tkAll.n})`);
console.log(`  maker gross on FILLED only       ${(mkAll.gross>=0?"+":"")+mkAll.gross.toFixed(3)}R  (n=${mkAll.n})`);
console.log(`  -> ${mkAll.gross < tkAll.gross
  ? `filled subset is WORSE by ${(tkAll.gross - mkAll.gross).toFixed(3)}R: adverse selection is real`
  : `filled subset is better by ${(mkAll.gross - tkAll.gross).toFixed(3)}R: the better entry price wins`}`);
console.log(`  net comparison: taker ${(tkAll.net>=0?"+":"")+tkAll.net.toFixed(3)}R vs maker ${(mkAll.net>=0?"+":"")+mkAll.net.toFixed(3)}R` +
  ` -> maker ${mkAll.net > tkAll.net ? "WINS" : "loses"} by ${Math.abs(mkAll.net - tkAll.net).toFixed(3)}R`);
