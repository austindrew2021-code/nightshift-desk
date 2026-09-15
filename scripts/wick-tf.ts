/**
 * The weekly-low wick reversal across timeframes, level lookbacks and exits.
 *
 *   npm run wicktf:ict
 *
 * Row 55 found one point in a large space: 1H bars, prior-week low, wick >= 60%,
 * hold 24h. This sweeps the space around it — bar size, how far back the level
 * looks, hold length, and exit rule — with the same train/validation/holdout
 * discipline and a Bonferroni bar, because this is again many tests.
 *
 * On "5-20% per trade": that is an ACCOUNT return at leverage, not a price move.
 * At 10x a +1% move is +10% on the account. Row 55's +1.0% per trade is already
 * ~5% per trade at 5x. Leverage multiplies the drawdown by the same factor, which
 * is where row 55's 56% comes from. Nothing here changes that arithmetic.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, atr } from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = "/tmp/nightshift-1h-3y";
const COST = Number(process.env.COST_BP ?? 14) / 10_000;

const raw: { sym: string; cs: Candle[] }[] = [];
for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") continue;
  const f = join(CACHE, `${a.instId}.json`);
  if (!existsSync(f)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(f, "utf8")) as number[][]);
  if (cs.length >= 8000) raw.push({ sym: a.symbol, cs });
}
if (!raw.length) { console.log(`no cache at ${CACHE}`); process.exit(1); }

function fold(cs: Candle[], n: number): Candle[] {
  if (n === 1) return cs;
  const out: Candle[] = [];
  for (let i = 0; i + n <= cs.length; i += n) {
    const g = cs.slice(i, i + n);
    out.push({ t: g[0]!.t, o: g[0]!.o, c: g[g.length - 1]!.c,
      h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)),
      v: g.reduce((s, x) => s + (x.v || 0), 0) });
  }
  return out;
}

interface Tr { t: number; ret: number }

/**
 * exit: "time"  hold `hold` bars
 *       "level" exit when price closes back above the swept level, else time cap
 *       "atr"   exit at +`tp` ATR or -`sl` ATR, else time cap
 */
function run(barN: number, lookBars: number, wick: number, hold: number,
             exit: "time" | "level" | "atr", tp = 2, sl = 1): Tr[] {
  const out: Tr[] = [];
  for (const b of raw) {
    const cs = fold(b.cs, barN);
    if (cs.length < lookBars + hold + 60) continue;
    const lo = new Array<number>(cs.length).fill(NaN);
    for (let i = lookBars; i < cs.length; i++) {
      let v = Infinity;
      for (let k = i - lookBars; k < i; k++) v = Math.min(v, cs[k]!.l);
      lo[i] = v;
    }
    for (let i = lookBars + 20; i < cs.length - hold; i++) {
      const c = cs[i]!, lvl = lo[i]!;
      if (!isFinite(lvl) || c.l > lvl) continue;
      if (cs[i - 1]!.l <= lo[i - 1]!) continue;         // first touch
      const rng = Math.max(1e-9, c.h - c.l);
      if ((Math.min(c.o, c.c) - c.l) / rng < wick) continue;
      const a = atr(cs, i);
      if (!(a > 0)) continue;
      const entry = c.c;
      let ret: number | null = null;
      if (exit === "time") ret = (cs[i + hold]!.c - entry) / entry;
      else if (exit === "level") {
        for (let k = i + 1; k <= Math.min(cs.length - 1, i + hold); k++) {
          if (cs[k]!.c > lvl) { ret = (cs[k]!.c - entry) / entry; break; }
        }
        if (ret === null) ret = (cs[Math.min(cs.length - 1, i + hold)]!.c - entry) / entry;
      } else {
        const up = entry + a * tp, dn = entry - a * sl;
        for (let k = i + 1; k <= Math.min(cs.length - 1, i + hold); k++) {
          if (cs[k]!.l <= dn) { ret = (dn - entry) / entry; break; }   // stop first
          if (cs[k]!.h >= up) { ret = (up - entry) / entry; break; }
        }
        if (ret === null) ret = (cs[Math.min(cs.length - 1, i + hold)]!.c - entry) / entry;
      }
      out.push({ t: c.t, ret: ret - COST });
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

function stat(s: Tr[]) {
  const n = s.length;
  if (n < 40) return null;
  const m = s.reduce((a, b) => a + b.ret, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b.ret - m) ** 2, 0) / n) || 1e-12;
  return { n, mean: m, win: s.filter((x) => x.ret > 0).length / n, t: (m / sd) * Math.sqrt(n) };
}

const spanAll = run(1, 168, 0.6, 24, "time");
const T0 = spanAll[0]!.t, T1 = spanAll[spanAll.length - 1]!.t;
const CV = T0 + (T1 - T0) * 0.5, CH = T0 + (T1 - T0) * 0.75;
const days = (T1 - T0) / 86_400_000;

const TFS = [{ n: 1, l: "1H " }, { n: 4, l: "4H " }, { n: 12, l: "12H" }, { n: 24, l: "1D " }];
const LOOKS = [{ h: 24, l: "day" }, { h: 168, l: "week" }, { h: 720, l: "month" }, { h: 2160, l: "quarter" }];

const cfgs: { label: string; bar: number; look: number; wick: number; hold: number; exit: "time" | "level" | "atr"; tp?: number; sl?: number }[] = [];
for (const tf of TFS) for (const lk of LOOKS) {
  const lookBars = Math.round(lk.h / tf.n);
  if (lookBars < 6 || lookBars > 400) continue;
  const hold = Math.max(2, Math.round(24 / tf.n));
  cfgs.push({ label: `${tf.l} ${lk.l.padEnd(7)} wick60 hold24h time`, bar: tf.n, look: lookBars, wick: 0.6, hold, exit: "time" });
}
// exits and holds around the row-55 point
for (const hold of [12, 24, 48, 96]) cfgs.push({ label: `1H  week    wick60 hold${hold}h time`, bar: 1, look: 168, wick: 0.6, hold, exit: "time" });
cfgs.push({ label: `1H  week    wick60 exit-on-reclaim`, bar: 1, look: 168, wick: 0.6, hold: 96, exit: "level" });
for (const [tp, sl] of [[2, 1], [3, 1.5], [4, 2]]) cfgs.push({ label: `1H  week    wick60 ${tp}atr tp / ${sl}atr sl`, bar: 1, look: 168, wick: 0.6, hold: 96, exit: "atr", tp, sl });
for (const w of [0.5, 0.7, 0.8]) cfgs.push({ label: `1H  week    wick${(w*100).toFixed(0)} hold24h time`, bar: 1, look: 168, wick: w, hold: 24, exit: "time" });

const BONF = 2.807 + 0.5 * Math.log(cfgs.length / 50);
console.log(`${raw.length} pairs · ${days.toFixed(0)} days · ${(COST*10_000).toFixed(0)}bp round trip · ${cfgs.length} configs`);
console.log(`Bonferroni bar |t| > ${BONF.toFixed(2)}   ( *** = positive in all 3 splits AND all-sample t clears )\n`);
console.log("config                              n    /mo   TRAIN     VAL      HOLD      all      t");
console.log("─".repeat(96));

const rows = cfgs.map((cf) => {
  const all = run(cf.bar, cf.look, cf.wick, cf.hold, cf.exit, cf.tp, cf.sl);
  const tr = stat(all.filter((x) => x.t < CV)), v = stat(all.filter((x) => x.t >= CV && x.t < CH));
  const h = stat(all.filter((x) => x.t >= CH)), a = stat(all);
  return { cf, tr, v, h, a, n: all.length };
}).filter((r) => r.tr && r.v && r.h && r.a);

rows.sort((a, b) => b.a!.t - a.a!.t);
for (const r of rows) {
  const stable = r.tr!.mean > 0 && r.v!.mean > 0 && r.h!.mean > 0;
  const mark = stable && r.a!.t > BONF ? "  ***" : stable ? "  (stable)" : "";
  const f = (s: NonNullable<ReturnType<typeof stat>>) => `${(s.mean*100>=0?"+":"")+(s.mean*100).toFixed(2)}%`.padStart(8);
  console.log(`${r.cf.label.padEnd(36)}${String(r.n).padStart(5)} ${(r.n/days*30).toFixed(1).padStart(5)} ` +
    `${f(r.tr!)}${f(r.v!)}${f(r.h!)}${f(r.a!)} ${r.a!.t.toFixed(1).padStart(5)}${mark}`);
}
