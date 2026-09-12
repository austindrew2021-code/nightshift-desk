/**
 * ICT backtest with an out-of-sample split.
 *
 *   npm run backtest:ict              # ~40 days of 15m, cached after first run
 *   npm run backtest:ict -- 1H 60     # bar + pages (100 bars/page)
 *
 * Why the split: any strategy can be tuned to look good on the data you tuned
 * it on. TRAIN is the first 60% of history and TEST the last 40%. A change is
 * only real if it improves TEST. If TRAIN improves and TEST does not, the change
 * fitted noise — discard it.
 *
 * Costs default to DEFAULT_ICT_COSTS. Pass --free to see the frictionless
 * numbers the engine used to report.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  scanIct, simulateIct, parseKlines,
  isLondon, isNyAm, isSilver, isNyPm,
  DEFAULT_ICT_COSTS, ZERO_ICT_COSTS,
} from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import { ICT_LEVERAGE, ICT_MARGIN_PCT, BANK_EVERY_USD, BANK_RATE } from "../src/lib/engine/types.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BAR = args[0] ?? "15m";
const PAGES = Number(args[1] ?? 40);
const FREE = process.argv.includes("--free");
const KILLZONE = process.argv.includes("--killzone");
const COSTS = FREE ? ZERO_ICT_COSTS : DEFAULT_ICT_COSTS;
const CACHE = join(process.env.TMPDIR ?? "/tmp", `nightshift-bt-${BAR}-${PAGES}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function history(instId: string): Promise<Candle[]> {
  mkdirSync(CACHE, { recursive: true });
  const f = join(CACHE, `${instId}.json`);
  if (existsSync(f)) return parseKlines(JSON.parse(readFileSync(f, "utf8")));
  const rows: number[][] = [];
  let after = "";
  for (let page = 0; page < PAGES; page++) {
    const url =
      `https://www.okx.com/api/v5/market/history-candles?instId=${instId}` +
      `&bar=${BAR}&limit=100${after ? `&after=${after}` : ""}`;
    let data: string[][] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url);
        if (r.status === 429) { await sleep(1200 * (attempt + 1)); continue; }
        const j = (await r.json()) as { data?: string[][] };
        data = j.data ?? [];
        break;
      } catch { await sleep(600 * (attempt + 1)); }
    }
    if (!data.length) break;
    rows.push(...data.map((x) => x.slice(0, 6).map(Number)));
    after = String(data[data.length - 1]![0]);
    await sleep(120);                       // stay under the public rate limit
  }
  // OKX returns newest-first per page and we appended pages going back, so one
  // ascending sort fixes both. parseKlines does no sorting of its own.
  rows.sort((a, b) => a[0]! - b[0]!);
  const dedup = rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1]![0]);
  writeFileSync(f, JSON.stringify(dedup));
  return parseKlines(dedup);
}

interface Trade { t: number; closedAt: number; setup: string; r: number; stopPct: number; kill: boolean; sym: string }

const trades: Trade[] = [];
let bars = 0;
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const cs = await history(a.instId);
  if (cs.length < 120) { console.log(`${a.id}: only ${cs.length} bars, skipped`); continue; }
  bars += cs.length;
  const sigs = scanIct(cs, KILLZONE ? { killZoneOnly: true } : undefined);
  for (const tr of simulateIct(cs, sigs, 1, a.symbol, a.name, COSTS)) {
    const sg = sigs.find((s) => s.t === tr.openedAt && s.setup === tr.setup);
    trades.push({
      t: tr.openedAt, closedAt: tr.closedAt, setup: tr.setup, r: tr.rMultiple, sym: a.symbol,
      stopPct: sg ? Math.abs(sg.entry - sg.stop) / Math.max(1e-9, sg.entry) : 0.004,
      kill: isLondon(tr.openedAt) || isNyAm(tr.openedAt) || isSilver(tr.openedAt) || isNyPm(tr.openedAt),
    });
  }
}
trades.sort((x, y) => x.t - y.t);

if (!trades.length) { console.log("no trades — check the fetch"); process.exit(1); }
const t0 = trades[0]!.t, t1 = trades[trades.length - 1]!.closedAt;
const days = (t1 - t0) / 86_400_000;
const cut = t0 + (t1 - t0) * 0.6;
const TRAIN = trades.filter((t) => t.t < cut);
const TEST = trades.filter((t) => t.t >= cut);

console.log(`${BAR} · ${bars} bars across ${ICT_ASSETS.filter(a=>a.venue==="okx").length} books · ${days.toFixed(0)} days`);
console.log(`costs: ${FREE ? "NONE (--free)" : `fee ${DEFAULT_ICT_COSTS.feeRate*100}%/side, slip ${DEFAULT_ICT_COSTS.slipRate*100}%/side, funding ${DEFAULT_ICT_COSTS.fundingRate8h*100}%/8h`}`);
console.log(`gate: ${KILLZONE ? "killZoneOnly ON" : "all hours"}`);
console.log(`${trades.length} trades — train ${TRAIN.length} / test ${TEST.length}\n`);

function ledger(set: Trade[], riskPct: number) {
  const start = 100; let cash = start, banked = 0, peak = start, maxDD = 0, worst = 0;
  for (const t of set) {
    const book = Math.max(start * 0.25, cash);
    const risk = Math.max(1, book * riskPct);
    // notional is capped exactly as ictRiskUsd caps it
    const capped = Math.min(risk / Math.max(1e-6, t.stopPct), book * ICT_MARGIN_PCT * ICT_LEVERAGE);
    const effRisk = capped * t.stopPct;
    cash += t.r * effRisk;
    worst = Math.min(worst, t.r);
    if (cash <= 0) return { eq: 0, maxDD: 1, blew: true, worst };
    const lifetime = cash + banked - start;
    const tgt = Math.floor(lifetime / BANK_EVERY_USD) * (BANK_EVERY_USD * BANK_RATE);
    const take = Math.min(Math.max(0, tgt - banked), Math.max(0, cash - start * 0.25));
    if (take >= 1) { banked += take; cash -= take; }
    const eq = cash + banked; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak);
  }
  return { eq: cash + banked, maxDD, blew: false, worst };
}

function expectancy(set: Trade[]) {
  const n = set.length || 1;
  const w = set.filter((t) => t.r > 0);
  const l = set.filter((t) => t.r <= 0);
  const avg = set.reduce((s, t) => s + t.r, 0) / n;
  const sd = Math.sqrt(set.reduce((s, t) => s + (t.r - avg) ** 2, 0) / n) || 1;
  return {
    n: set.length, win: w.length / n, avgR: avg,
    avgWin: w.length ? w.reduce((s, t) => s + t.r, 0) / w.length : 0,
    avgLoss: l.length ? l.reduce((s, t) => s + t.r, 0) / l.length : 0,
    // Expectancy per unit of variance: the closest thing to "is this real"
    sharpeish: (avg / sd) * Math.sqrt(set.length),
  };
}

function block(label: string, set: Trade[]) {
  const e = expectancy(set);
  console.log(`${label}`);
  console.log(`  n=${e.n}  win ${(e.win*100).toFixed(0)}%  avgR ${e.avgR>=0?"+":""}${e.avgR.toFixed(3)}  avgWin +${e.avgWin.toFixed(2)}  avgLoss ${e.avgLoss.toFixed(2)}  t-ish ${e.sharpeish.toFixed(1)}`);
  for (const rp of [0.02, 0.06, 0.12]) {
    const L = ledger(set, rp);
    console.log(`  risk ${String(rp*100).padStart(2)}%/trade -> $${L.eq.toFixed(0).padStart(7)}  ${(L.eq/100).toFixed(1).padStart(6)}x  maxDD ${(L.maxDD*100).toFixed(0).padStart(3)}%${L.blew?"  BLEW UP":""}`);
  }
  console.log();
}

block("ALL", trades);
block("TRAIN (first 60%)", TRAIN);
block("TEST  (last 40%, out of sample)", TEST);
block("TEST, kill zones only", TEST.filter((t) => t.kill));

console.log("per setup — TRAIN vs TEST avgR (a setup that only works in TRAIN is fitted):");
const setups = [...new Set(trades.map((t) => t.setup))];
const rows = setups.map((s) => {
  const tr = TRAIN.filter((t) => t.setup === s), te = TEST.filter((t) => t.setup === s);
  const a = (x: Trade[]) => x.length ? x.reduce((q, t) => q + t.r, 0) / x.length : NaN;
  return { s, ntr: tr.length, atr: a(tr), nte: te.length, ate: a(te) };
}).sort((x, y) => (y.nte || 0) - (x.nte || 0));
for (const r of rows) {
  const f = (v: number) => Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "  n/a";
  const verdict = !Number.isFinite(r.ate) ? "no test data"
    : r.ate > 0.05 && r.atr > 0.05 ? "holds up"
    : r.ate <= 0.05 && r.atr > 0.05 ? "TRAIN ONLY — fitted"
    : r.ate > 0.05 ? "test-only, thin" : "negative";
  console.log(`  ${r.s.padEnd(9)} train n=${String(r.ntr).padStart(3)} ${f(r.atr)}R   test n=${String(r.nte).padStart(3)} ${f(r.ate)}R   ${verdict}`);
}
console.log(`\ncache: ${CACHE}  (delete to refetch)`);
