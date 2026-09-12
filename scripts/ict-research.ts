/**
 * Strategy search with a three-way split.
 *
 *   npm run research:ict            # uses the 15m cache from backtest:ict
 *
 * Testing many candidates against one test set means the winner is chosen BY
 * that set, so its score is no longer out-of-sample. So:
 *
 *   TRAIN      50%  develop
 *   VALIDATION 25%  compare candidates, pick one
 *   HOLDOUT    25%  scored ONCE, for the pick only
 *
 * The holdout number is the only one that estimates future performance. Every
 * other column is selection material.
 *
 * No sub-bars here (the 5m cache covers 41 days, this runs 181), so stop-vs-target
 * inside a bar resolves stop-first — conservative, in the honest direction.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scanIct, simulateIct, parseKlines, DEFAULT_ICT_COSTS, type IctSignal } from "../src/lib/engine/ict.ts";
import { scanPoc, scanNyOpen, scanNyClose, scanDiv } from "../src/lib/engine/strategies.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import { ICT_LEVERAGE, ICT_MARGIN_PCT, BANK_EVERY_USD, BANK_RATE } from "../src/lib/engine/types.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const BAR = process.argv[2] ?? "15m";
const PAGES = process.argv[3] ?? "175";
const CACHE = join(process.env.TMPDIR ?? "/tmp", `nightshift-bt-${BAR}-${PAGES}`);

const books: { sym: string; name: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 200) books.push({ sym: a.symbol, name: a.name, cs });
}
if (!books.length) { console.log(`no cache at ${CACHE}`); process.exit(1); }

interface T { t: number; r: number; stopPct: number }

function run(gen: (cs: Candle[]) => IctSignal[]): T[] {
  const out: T[] = [];
  for (const b of books) {
    const sigs = gen(b.cs);
    if (!sigs.length) continue;
    for (const tr of simulateIct(b.cs, sigs, 1, b.sym, b.name, DEFAULT_ICT_COSTS)) {
      const sg = sigs.find((s) => s.t === tr.openedAt && s.setup === tr.setup);
      out.push({
        t: tr.openedAt, r: tr.rMultiple,
        stopPct: sg ? Math.abs(sg.entry - sg.stop) / Math.max(1e-9, sg.entry) : 0.004,
      });
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

// Split boundaries from the full candle span, so every candidate uses the same dates.
const allT = books.flatMap((b) => [b.cs[0]!.t, b.cs[b.cs.length - 1]!.t]);
const t0 = Math.min(...allT), t1 = Math.max(...allT);
const cutV = t0 + (t1 - t0) * 0.5;
const cutH = t0 + (t1 - t0) * 0.75;
const days = (t1 - t0) / 86_400_000;

function ledger(set: T[], riskPct: number) {
  const start = 100; let cash = start, banked = 0, peak = start, maxDD = 0;
  for (const t of set) {
    const book = Math.max(start * 0.25, cash);
    const risk = book * riskPct;                      // no $1 floor: board row 16
    const capped = Math.min(risk / Math.max(1e-6, t.stopPct), book * ICT_MARGIN_PCT * ICT_LEVERAGE);
    cash += t.r * capped * t.stopPct;
    if (cash <= 0.01) return { eq: 0, maxDD: 1, blew: true };
    const lifetime = cash + banked - start;
    const tgt = Math.floor(lifetime / BANK_EVERY_USD) * (BANK_EVERY_USD * BANK_RATE);
    const take = Math.min(Math.max(0, tgt - banked), Math.max(0, cash - start * 0.25));
    if (take >= 1) { banked += take; cash -= take; }
    const eq = cash + banked; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak);
  }
  return { eq: cash + banked, maxDD, blew: false };
}

function stat(set: T[]) {
  const n = set.length;
  if (n < 2) return { n, win: 0, avgR: 0, t: 0 };
  const avg = set.reduce((s, x) => s + x.r, 0) / n;
  const sd = Math.sqrt(set.reduce((s, x) => s + (x.r - avg) ** 2, 0) / n) || 1;
  return { n, win: set.filter((x) => x.r > 0).length / n, avgR: avg, t: (avg / sd) * Math.sqrt(n) };
}

const CANDIDATES: { label: string; gen: (cs: Candle[]) => IctSignal[] }[] = [
  { label: "ICT all (shipped)",   gen: (cs) => scanIct(cs, { killZoneOnly: true }) },
  { label: "ICT all hours",       gen: (cs) => scanIct(cs) },
  { label: "div regular only",    gen: (cs) => scanDiv(cs, "regular") },
  { label: "div hidden only",     gen: (cs) => scanDiv(cs, "hidden") },
  { label: "div both (isolated)", gen: (cs) => scanDiv(cs, "all") },
  { label: "POC reversion",       gen: (cs) => scanPoc(cs, "rev") },
  { label: "POC rejection",       gen: (cs) => scanPoc(cs, "rej") },
  { label: "POC breakout",        gen: (cs) => scanPoc(cs, "brk") },
  { label: "POC all",             gen: (cs) => scanPoc(cs, "all") },
  { label: "NY open ORB",         gen: (cs) => scanNyOpen(cs, "orb") },
  { label: "NY open fade",        gen: (cs) => scanNyOpen(cs, "fade") },
  { label: "NY close reversal",   gen: (cs) => scanNyClose(cs, "rev") },
  { label: "NY close drift",      gen: (cs) => scanNyClose(cs, "drift") },
  { label: "NY open+close all",   gen: (cs) => [...scanNyOpen(cs), ...scanNyClose(cs)] },
  { label: "POC + div hidden",    gen: (cs) => [...scanPoc(cs, "all"), ...scanDiv(cs, "hidden")] },
  { label: "everything",          gen: (cs) => [...scanIct(cs, { killZoneOnly: true }), ...scanPoc(cs), ...scanNyOpen(cs), ...scanNyClose(cs)] },
];

console.log(`${BAR} · ${books.length} books · ${days.toFixed(0)} days · costs on`);
console.log(`train <${new Date(cutV).toISOString().slice(0,10)}  validation <${new Date(cutH).toISOString().slice(0,10)}  holdout after\n`);
console.log("candidate               │ TRAIN            │ VALIDATION  (selection)");
console.log("                        │    n  win   avgR │    n  win    avgR      t");
console.log("─".repeat(76));

const scored: { label: string; gen: (cs: Candle[]) => IctSignal[]; v: ReturnType<typeof stat>; all: T[] }[] = [];
for (const c of CANDIDATES) {
  const all = run(c.gen);
  const tr = stat(all.filter((x) => x.t < cutV));
  const v = stat(all.filter((x) => x.t >= cutV && x.t < cutH));
  scored.push({ label: c.label, gen: c.gen, v, all });
  const f = (s: ReturnType<typeof stat>, withT = false) =>
    `${String(s.n).padStart(5)} ${(s.win*100).toFixed(0).padStart(3)}%  ${(s.avgR>=0?"+":"")}${s.avgR.toFixed(3)}` +
    (withT ? ` ${s.t.toFixed(1).padStart(6)}` : "");
  console.log(`${c.label.padEnd(23)} │ ${f(tr)} │ ${f(v, true)}`);
}

// Selection rule, fixed in advance: highest validation t among candidates with
// at least 60 validation trades and positive validation expectancy.
const eligible = scored.filter((s) => s.v.n >= 60 && s.v.avgR > 0);
eligible.sort((a, b) => b.v.t - a.v.t);
const pick = eligible[0];

console.log("\n" + "─".repeat(76));
if (!pick) {
  console.log("NOTHING SELECTED. No candidate had >=60 validation trades AND positive");
  console.log("validation expectancy, so there is nothing worth scoring on the holdout.");
  console.log("Scoring one anyway would just be picking the best of a losing set.");
  process.exit(0);
}

console.log(`SELECTED on validation: ${pick.label}  (avgR ${pick.v.avgR >= 0 ? "+" : ""}${pick.v.avgR.toFixed(3)}, t ${pick.v.t.toFixed(1)}, n ${pick.v.n})`);
const hold = pick.all.filter((x) => x.t >= cutH);
const h = stat(hold);
console.log(`\nHOLDOUT — scored once, never used for selection:`);
console.log(`  n=${h.n}  win ${(h.win*100).toFixed(0)}%  avgR ${h.avgR>=0?"+":""}${h.avgR.toFixed(3)}  t ${h.t.toFixed(1)}`);
const holdDays = (t1 - cutH) / 86_400_000;
console.log(`  window ${holdDays.toFixed(0)} days, $100 start, compounding, banking 50% per $100 gained:`);
for (const rp of [0.02, 0.06, 0.12, 0.25]) {
  const L = ledger(hold, rp);
  const wk = L.eq > 0 ? Math.pow(L.eq / 100, 7 / holdDays) : 0;
  console.log(`    risk ${String(rp*100).padStart(3)}%/trade -> $${L.eq.toFixed(0).padStart(7)}  maxDD ${(L.maxDD*100).toFixed(0).padStart(3)}%  ${L.blew ? "RUIN" : `${wk.toFixed(2)}x/week`}`);
}
console.log(`\nt below ~2 on the holdout means this is not distinguishable from zero,`);
console.log(`whatever the dollar column says.`);
