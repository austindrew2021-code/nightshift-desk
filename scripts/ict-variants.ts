/**
 * Strategy-version sweep with an out-of-sample split.
 *
 *   npm run variants:ict
 *
 * Each row is a variant scored on TRAIN (first 60% of history) and TEST (last
 * 40%). Read the TEST column and nothing else. A variant that improves TRAIN and
 * not TEST fitted noise — that is the whole point of showing both.
 *
 * t-ish is avgR/sd * sqrt(n): a rough t-statistic for "is this expectancy
 * distinguishable from zero". Below ~2 on TEST, treat the variant as unproven no
 * matter how good the dollar figure looks — the dollars are one ordering of one
 * sample.
 *
 * Uses the candle cache written by scripts/ict-backtest.ts. Run that first.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  scanIct, simulateIct, parseKlines,
  DEFAULT_ICT_COSTS, type IctSimOpts, type IctSignal,
} from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import { ICT_LEVERAGE, ICT_MARGIN_PCT, BANK_EVERY_USD, BANK_RATE } from "../src/lib/engine/types.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const BAR = process.argv[2] ?? "15m";
const PAGES = process.argv[3] ?? "40";
const CACHE = join(process.env.TMPDIR ?? "/tmp", `nightshift-bt-${BAR}-${PAGES}`);

const books: { sym: string; name: string; cs: Candle[]; sigs: IctSignal[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length < 120) continue;
  books.push({ sym: a.symbol, name: a.name, cs, sigs: scanIct(cs, { killZoneOnly: true }) });
}
if (!books.length) {
  console.log(`no cache at ${CACHE} — run: npm run backtest:ict -- ${BAR} ${PAGES}`);
  process.exit(1);
}

interface T { t: number; r: number; stopPct: number }

function collect(opts: IctSimOpts): T[] {
  const out: T[] = [];
  for (const b of books) {
    const o: IctSimOpts = opts.exitOnOpposing ? { ...opts, opposing: b.sigs } : opts;
    for (const tr of simulateIct(b.cs, b.sigs, 1, b.sym, b.name, DEFAULT_ICT_COSTS, o)) {
      const sg = b.sigs.find((s) => s.t === tr.openedAt && s.setup === tr.setup);
      out.push({
        t: tr.openedAt, r: tr.rMultiple,
        stopPct: sg ? Math.abs(sg.entry - sg.stop) / Math.max(1e-9, sg.entry) : 0.004,
      });
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

const spanAll = collect({});
const t0 = spanAll[0]!.t, t1 = spanAll[spanAll.length - 1]!.t;
const cut = t0 + (t1 - t0) * 0.6;

function ledger(set: T[], riskPct: number) {
  const start = 100; let cash = start, banked = 0, peak = start, maxDD = 0;
  for (const t of set) {
    const book = Math.max(start * 0.25, cash);
    const risk = Math.max(1, book * riskPct);
    const capped = Math.min(risk / Math.max(1e-6, t.stopPct), book * ICT_MARGIN_PCT * ICT_LEVERAGE);
    cash += t.r * capped * t.stopPct;
    if (cash <= 0) return { eq: 0, maxDD: 1, blew: true };
    const lifetime = cash + banked - start;
    const tgt = Math.floor(lifetime / BANK_EVERY_USD) * (BANK_EVERY_USD * BANK_RATE);
    const take = Math.min(Math.max(0, tgt - banked), Math.max(0, cash - start * 0.25));
    if (take >= 1) { banked += take; cash -= take; }
    const eq = cash + banked; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak);
  }
  return { eq: cash + banked, maxDD, blew: false };
}

function score(set: T[]) {
  const n = set.length;
  if (!n) return { n: 0, win: 0, avgR: 0, t: 0, eq: 100, dd: 0 };
  const avg = set.reduce((s, x) => s + x.r, 0) / n;
  const sd = Math.sqrt(set.reduce((s, x) => s + (x.r - avg) ** 2, 0) / n) || 1;
  const L = ledger(set, 0.06);
  return {
    n, win: set.filter((x) => x.r > 0).length / n, avgR: avg,
    t: (avg / sd) * Math.sqrt(n), eq: L.eq, dd: L.maxDD,
  };
}

const VARIANTS: { label: string; opts: IctSimOpts }[] = [
  { label: "baseline (shipped)",      opts: {} },
  { label: "exit on reversal",        opts: { exitOnOpposing: true } },
  { label: "breakeven at 1R",         opts: { beAt1R: true } },
  { label: "trail every setup",       opts: { trailAll: true } },
  { label: "target 1.5R",             opts: { targetMult: 1.5 } },
  { label: "target 3R",               opts: { targetMult: 3 } },
  { label: "BE@1R + trail all",       opts: { beAt1R: true, trailAll: true } },
  { label: "BE@1R + exit reversal",   opts: { beAt1R: true, exitOnOpposing: true } },
  { label: "trail all + 3R",          opts: { trailAll: true, targetMult: 3 } },
  { label: "BE@1R + trail + 3R",      opts: { beAt1R: true, trailAll: true, targetMult: 3 } },
];

console.log(`${BAR} · ${books.length} books · killZoneOnly · costs on · $100 start, 6% risk/trade\n`);
console.log("variant                  │ TRAIN                        │ TEST (out of sample)");
console.log("                         │   n  win   avgR    $   t     │   n  win   avgR    $   t    maxDD");
console.log("─".repeat(101));
for (const v of VARIANTS) {
  const all = collect(v.opts);
  const tr = score(all.filter((x) => x.t < cut));
  const te = score(all.filter((x) => x.t >= cut));
  const f = (s: ReturnType<typeof score>) =>
    `${String(s.n).padStart(4)} ${(s.win*100).toFixed(0).padStart(3)}% ${(s.avgR>=0?"+":"")}${s.avgR.toFixed(3)} ${("$"+s.eq.toFixed(0)).padStart(6)} ${s.t.toFixed(1).padStart(5)}`;
  console.log(`${v.label.padEnd(24)} │ ${f(tr)} │ ${f(te)} ${(te.dd*100).toFixed(0).padStart(5)}%`);
}
console.log("\nRead TEST only. t below ~2 means the expectancy is not distinguishable");
console.log("from zero on this sample, whatever the dollar column says.");
