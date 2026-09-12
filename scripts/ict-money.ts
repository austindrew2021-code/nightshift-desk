/**
 * Money management under uncertainty: risk size x banking policy x margin.
 *
 *   npm run money:ict
 *
 * A single backtest path is ONE ordering of the trades. Reorder them and the
 * dollar figure changes completely, because compounding is path-dependent. So
 * instead of one path this resamples thousands using a BLOCK bootstrap (blocks of
 * 20 consecutive trades, preserving the clustering real trades have) and reports
 * the distribution.
 *
 * The numbers that matter are P(ruin) and P(hit target) — not the median dollar
 * figure, and certainly not the best case.
 *
 * Trade source: the strategy selected in scripts/ict-research.ts (ICT as shipped,
 * killZoneOnly), full 182-day sample, costs on.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scanIct, simulateIct, parseKlines, DEFAULT_ICT_COSTS } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import { ICT_LEVERAGE } from "../src/lib/engine/types.ts";
import { POLICIES, applyBanking, type BankPolicy, type BankState } from "../src/lib/engine/banking.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const BAR = process.argv[2] ?? "15m";
const PAGES = process.argv[3] ?? "175";
const CACHE = join(process.env.TMPDIR ?? "/tmp", `nightshift-bt-${BAR}-${PAGES}`);
const PATHS = Number(process.env.PATHS ?? 4000);
const TARGET = 1000;
const DAYS = 30;

interface T { r: number; stopPct: number }
const trades: T[] = [];
let spanMs = 0, spanBooks = 0;
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs: Candle[] = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length < 200) continue;
  spanMs = Math.max(spanMs, cs[cs.length - 1]!.t - cs[0]!.t);
  spanBooks++;
  const sigs = scanIct(cs, { killZoneOnly: true });
  for (const tr of simulateIct(cs, sigs, 1, a.symbol, a.name, DEFAULT_ICT_COSTS)) {
    const sg = sigs.find((s) => s.t === tr.openedAt && s.setup === tr.setup);
    trades.push({
      r: tr.rMultiple,
      stopPct: sg ? Math.abs(sg.entry - sg.stop) / Math.max(1e-9, sg.entry) : 0.004,
    });
  }
}
if (trades.length < 100) { console.log(`not enough trades — run: npm run backtest:ict -- ${BAR} ${PAGES}`); process.exit(1); }

const spanDays = spanMs / 86_400_000;
const perDay = trades.length / spanDays;
const N = Math.max(20, Math.round(perDay * DAYS));
const avgR = trades.reduce((s, t) => s + t.r, 0) / trades.length;
const sd = Math.sqrt(trades.reduce((s, t) => s + (t.r - avgR) ** 2, 0) / trades.length);

console.log(`source: ${trades.length} trades, ${spanBooks} books, ${spanDays.toFixed(0)} days`);
console.log(`edge:   avgR ${avgR >= 0 ? "+" : ""}${avgR.toFixed(4)}  sd ${sd.toFixed(2)}  t ${(avgR / sd * Math.sqrt(trades.length)).toFixed(1)}`);
console.log(`sim:    ${PATHS} block-bootstrap paths of ${N} trades (~${DAYS} days at ${perDay.toFixed(1)}/day)\n`);

const BLOCK = 20;
let seed = 12345;
const rnd = () => {
  // xorshift32 — deterministic so the table reproduces
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return ((seed >>> 0) % 1e6) / 1e6;
};

function path(riskPct: number, marginPct: number, pol: BankPolicy): { eq: number; banked: number; dd: number; ruin: boolean; hit: boolean } {
  const start = 100;
  const s: BankState = { cash: start, banked: 0, peak: start, start };
  let peak = start, maxDD = 0, hit = false;
  let base = 0;
  for (let k = 0; k < N; k++) {
    if (k % BLOCK === 0) base = Math.floor(rnd() * trades.length);
    const t = trades[(base + (k % BLOCK)) % trades.length]!;
    const book = s.cash;
    if (book <= 0.5) return { eq: s.banked, banked: s.banked, dd: 1, ruin: true, hit };
    const risk = book * riskPct;
    const notional = Math.min(risk / Math.max(1e-6, t.stopPct), book * marginPct * ICT_LEVERAGE);
    s.cash += t.r * notional * t.stopPct;
    if (s.cash <= 0.5) return { eq: s.banked, banked: s.banked, dd: 1, ruin: true, hit };
    applyBanking(s, pol);
    const eq = s.cash + s.banked;
    if (eq >= TARGET) hit = true;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak);
  }
  return { eq: s.cash + s.banked, banked: s.banked, dd: maxDD, ruin: false, hit };
}

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

function sweep(marginPct: number) {
  console.log(`margin ${(marginPct * 100).toFixed(0)}% of book  (notional cap = book x ${(marginPct * ICT_LEVERAGE).toFixed(1)})`);
  console.log("  risk  policy                          median    P5     P95   P(ruin)  P($1k)  medDD");
  console.log("  " + "─".repeat(84));
  for (const riskPct of [0.06, 0.12, 0.25]) {
    for (const pol of POLICIES) {
      const eqs: number[] = [], dds: number[] = [];
      let ruin = 0, hit = 0;
      for (let i = 0; i < PATHS; i++) {
        const r = path(riskPct, marginPct, pol);
        eqs.push(r.eq); dds.push(r.dd);
        if (r.ruin) ruin++;
        if (r.hit) hit++;
      }
      eqs.sort((a, b) => a - b); dds.sort((a, b) => a - b);
      console.log(
        `  ${String(riskPct * 100).padStart(4)}%  ${pol.label.padEnd(30)} ` +
        `$${pct(eqs, 0.5).toFixed(0).padStart(5)} $${pct(eqs, 0.05).toFixed(0).padStart(5)} $${pct(eqs, 0.95).toFixed(0).padStart(6)}  ` +
        `${((ruin / PATHS) * 100).toFixed(0).padStart(5)}%  ${((hit / PATHS) * 100).toFixed(1).padStart(5)}%  ${(pct(dds, 0.5) * 100).toFixed(0).padStart(4)}%`,
      );
    }
  }
  console.log();
}

for (const m of [0.5, 0.6, 0.8]) sweep(m);
console.log(`P($1k) = share of ${PATHS} paths that touched $${TARGET} within ${DAYS} days.`);
console.log("P(ruin) = share where the trading book went to zero (banked cash survives).");
