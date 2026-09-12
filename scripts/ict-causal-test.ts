/**
 * The decisive test: does the ICT edge survive causal signal emission?
 *
 *   npm run causal:ict
 *
 * Same strategy, same data, same split. The only difference is whether the
 * scanner is allowed to see bars that had not happened when the signal fired.
 * Board row 20 / 34 / 35.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scanIct, simulateIct, parseKlines, DEFAULT_ICT_COSTS, type IctSignal } from "../src/lib/engine/ict.ts";
import { scanIctCausal } from "../src/lib/engine/causal.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import { ICT_LEVERAGE, ICT_MARGIN_PCT } from "../src/lib/engine/types.ts";
import { ratchet, applyBanking, type BankState } from "../src/lib/engine/banking.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = join(process.env.TMPDIR ?? "/tmp", `nightshift-bt-15m-${process.argv[2] ?? "175"}`);
const books: { sym: string; name: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 200) books.push({ sym: a.symbol, name: a.name, cs });
}
if (!books.length) { console.log(`no cache at ${CACHE}`); process.exit(1); }

interface T { t: number; r: number; stopPct: number; setup: string }
function run(gen: (cs: Candle[]) => IctSignal[]): T[] {
  const out: T[] = [];
  for (const b of books) {
    const sigs = gen(b.cs);
    for (const tr of simulateIct(b.cs, sigs, 1, b.sym, b.name, DEFAULT_ICT_COSTS)) {
      const sg = sigs.find((s) => s.t === tr.openedAt && s.setup === tr.setup);
      out.push({ t: tr.openedAt, r: tr.rMultiple, setup: tr.setup,
        stopPct: sg ? Math.abs(sg.entry - sg.stop) / Math.max(1e-9, sg.entry) : 0.004 });
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

const allT = books.flatMap((b) => [b.cs[0]!.t, b.cs[b.cs.length - 1]!.t]);
const t0 = Math.min(...allT), t1 = Math.max(...allT);
const cutV = t0 + (t1 - t0) * 0.5, cutH = t0 + (t1 - t0) * 0.75;

function stat(set: T[]) {
  const n = set.length;
  if (n < 2) return { n, win: 0, avgR: 0, t: 0 };
  const avg = set.reduce((s, x) => s + x.r, 0) / n;
  const sd = Math.sqrt(set.reduce((s, x) => s + (x.r - avg) ** 2, 0) / n) || 1;
  return { n, win: set.filter((x) => x.r > 0).length / n, avgR: avg, t: (avg / sd) * Math.sqrt(n) };
}
function ledger(set: T[], riskPct: number) {
  const start = 100; const s: BankState = { cash: start, banked: 0, peak: start, start };
  const pol = ratchet(0.6);
  let peak = start, dd = 0;
  for (const t of set) {
    if (s.cash <= 0.5) return { eq: s.banked, dd: 1 };
    const risk = s.cash * riskPct;
    const notional = Math.min(risk / Math.max(1e-6, t.stopPct), s.cash * ICT_MARGIN_PCT * ICT_LEVERAGE);
    s.cash += t.r * notional * t.stopPct;
    if (s.cash <= 0.5) return { eq: s.banked, dd: 1 };
    applyBanking(s, pol);
    const eq = s.cash + s.banked; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak);
  }
  return { eq: s.cash + s.banked, dd };
}

const MODES = [
  { label: "NAIVE  (lookahead allowed)", gen: (cs: Candle[]) => scanIct(cs, { killZoneOnly: true }) },
  { label: "CAUSAL (knowable only)",     gen: (cs: Candle[]) => scanIctCausal(cs, { killZoneOnly: true }) },
  // The causal run floods with `swing` (n=980 vs 19 naive), because pickDay's
  // per-NY-day filtering sees only a partial day inside a 240-bar rolling
  // window. Isolate it: if causal is still negative without swing, the verdict
  // is about the strategy rather than about this harness.
  { label: "CAUSAL no-swing",            gen: (cs: Candle[]) => scanIctCausal(cs, { killZoneOnly: true, skipSwing: true }) },
  { label: "NAIVE  no-swing",            gen: (cs: Candle[]) => scanIct(cs, { killZoneOnly: true, skipSwing: true }) },
];

console.log(`11 books · ${((t1 - t0) / 86_400_000).toFixed(0)} days · costs on · margin ${ICT_MARGIN_PCT * 100}% · ratchet-60\n`);
for (const m of MODES) {
  const all = run(m.gen);
  const tr = stat(all.filter((x) => x.t < cutV));
  const v = stat(all.filter((x) => x.t >= cutV && x.t < cutH));
  const h = all.filter((x) => x.t >= cutH);
  const hs = stat(h);
  const f = (s: ReturnType<typeof stat>) =>
    `n=${String(s.n).padStart(4)}  win ${(s.win * 100).toFixed(0).padStart(3)}%  avgR ${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(3)}  t ${s.t.toFixed(1).padStart(5)}`;
  console.log(m.label);
  console.log(`  train      ${f(tr)}`);
  console.log(`  validation ${f(v)}`);
  console.log(`  HOLDOUT    ${f(hs)}`);
  const days = (t1 - cutH) / 86_400_000;
  for (const rp of [0.06, 0.12, 0.25]) {
    const L = ledger(h, rp);
    console.log(`    ${String(rp * 100).padStart(3)}% risk -> $${L.eq.toFixed(0).padStart(5)} over ${days.toFixed(0)}d  maxDD ${(L.dd * 100).toFixed(0)}%`);
  }
  const bs = new Map<string, T[]>();
  for (const x of all) bs.set(x.setup, [...(bs.get(x.setup) ?? []), x]);
  console.log("    setups: " + [...bs].sort((a, b) => b[1].length - a[1].length)
    .map(([k, vv]) => `${k} n=${vv.length} ${(vv.reduce((s, x) => s + x.r, 0) / vv.length).toFixed(2)}R`).join("  "));
  console.log();
}
