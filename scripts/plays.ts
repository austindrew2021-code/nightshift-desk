/**
 * Multiple plays on the expanded universe.
 *
 *   npm run plays:ict
 *
 * Row 55/56 settled one play on 9 pairs: 1H, prior-week low swept, lower wick
 * >= 60%, hold 24h on time, no stop. It fires ~15 times a month, and with
 * maxOpen as the binding constraint, signal count is what limits compounding.
 *
 * Two ways to catch more:
 *   WIDER UNIVERSE  - 25 pairs instead of 9, same rule. Strictly more signals at
 *                     the same per-trade edge, and less concentration.
 *   MORE PLAYS      - the mirror (high sweep + upper wick, short), other levels,
 *                     and the other conditioners that cleared in row 55 as
 *                     separate entries. Overlap is measured, because two "plays"
 *                     firing on the same bar are one play wearing two names.
 *
 * Pairs are discovered from the cache rather than from ICT_ASSETS, which only
 * lists 12.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseKlines, atr, rsiWilder } from "../src/lib/engine/ict.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const CACHE = "/tmp/nightshift-1h-3y";
const COST = Number(process.env.COST_BP ?? 14) / 10_000;
const HOLD = 24;
const MIN_BARS = 20_000;

const books: { sym: string; cs: Candle[]; rsi: number[] }[] = [];
/**
 * ONLY env restricts the universe, so the 26-pair run can be compared directly
 * against row 55's original 9. If the same book() gives +1.8%/mo on 9 pairs and
 * -1.25%/mo on 26, the universe is the cause rather than a harness bug.
 */
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
for (const f of readdirSync(CACHE)) {
  if (!f.endsWith("-USDT.json")) continue;
  const sym = f.replace("-USDT.json", "");
  if (ONLY && !ONLY.has(sym)) continue;
  const cs = parseKlines(JSON.parse(readFileSync(join(CACHE, f), "utf8")) as number[][]);
  if (cs.length < MIN_BARS) continue;
  books.push({ sym, cs, rsi: rsiWilder(cs, 14) });
}
if (books.length < 5) { console.log(`only ${books.length} usable pairs`); process.exit(1); }

/** Rolling extreme over the `n` bars strictly BEFORE each bar. */
function rollExt(cs: Candle[], n: number, pick: "h" | "l") {
  const out = new Array<number>(cs.length).fill(NaN);
  for (let i = n; i < cs.length; i++) {
    let v = pick === "h" ? -Infinity : Infinity;
    for (let k = i - n; k < i; k++) v = pick === "h" ? Math.max(v, cs[k]!.h) : Math.min(v, cs[k]!.l);
    out[i] = v;
  }
  return out;
}

interface Ev { t: number; sym: string; ret: number; play: string; depthAtr: number; breadth: number }

interface Play {
  name: string;
  look: number;                      // level lookback in bars
  side: "long" | "short";
  cond: (c: Candle, ctx: { wick: number; rsi: number; vol: number; depthAtr: number }) => boolean;
}

const PLAYS: Play[] = [
  { name: "wkLow wick60",   look: 168,  side: "long",  cond: (_c, x) => x.wick >= 0.6 },
  { name: "wkLow volExp",   look: 168,  side: "long",  cond: (_c, x) => x.vol >= 1.5 && x.wick < 0.6 },
  { name: "wkLow RSI<25",   look: 168,  side: "long",  cond: (_c, x) => x.rsi < 25 && x.wick < 0.6 },
  { name: "wkLow deep",     look: 168,  side: "long",  cond: (_c, x) => x.depthAtr > 1.5 && x.wick < 0.6 },
  { name: "moLow wick60",   look: 720,  side: "long",  cond: (_c, x) => x.wick >= 0.6 },
  { name: "qtLow wick60",   look: 2160, side: "long",  cond: (_c, x) => x.wick >= 0.6 },
  { name: "wkHigh wick60",  look: 168,  side: "short", cond: (_c, x) => x.wick >= 0.6 },
  { name: "moHigh wick60",  look: 720,  side: "short", cond: (_c, x) => x.wick >= 0.6 },
];

function events(p: Play): Ev[] {
  const out: Ev[] = [];
  for (const b of books) {
    const cs = b.cs;
    const lvl = rollExt(cs, p.look, p.side === "long" ? "l" : "h");
    for (let i = p.look + 20; i < cs.length - HOLD; i++) {
      const c = cs[i]!, L = lvl[i]!;
      if (!isFinite(L)) continue;
      const hit = p.side === "long" ? c.l <= L : c.h >= L;
      if (!hit) continue;
      const prevHit = p.side === "long" ? cs[i - 1]!.l <= lvl[i - 1]! : cs[i - 1]!.h >= lvl[i - 1]!;
      if (prevHit) continue;                               // first touch only
      const a = atr(cs, i);
      if (!(a > 0)) continue;
      const rng = Math.max(1e-9, c.h - c.l);
      // "wick" is the rejection wick on the side being traded
      const wick = p.side === "long" ? (Math.min(c.o, c.c) - c.l) / rng : (c.h - Math.max(c.o, c.c)) / rng;
      const vol20 = cs.slice(i - 20, i).reduce((s, x) => s + (x.v || 0), 0) / 20;
      const ctx = { wick, rsi: b.rsi[i] ?? 50, vol: vol20 > 0 ? (c.v || 0) / vol20 : 1,
        depthAtr: Math.abs((p.side === "long" ? c.l : c.h) - L) / a };
      if (!p.cond(c, ctx)) continue;
      const raw = (cs[i + HOLD]!.c - c.c) / c.c;
      out.push({ t: c.t, sym: b.sym, play: p.name, depthAtr: ctx.depthAtr, breadth: 0,
        ret: (p.side === "long" ? raw : -raw) - COST });
    }
  }
  out.sort((a, b) => a.t - b.t);
  // breadth = how many other pairs already swept in the 6h BEFORE this bar closed.
  // Strictly backward-looking, so it is knowable at entry.
  const WIN = 6 * 3600_000;
  for (let i = 0; i < out.length; i++) {
    let k = i - 1, n = 0;
    while (k >= 0 && out[i]!.t - out[k]!.t <= WIN) { if (out[k]!.sym !== out[i]!.sym) n++; k--; }
    out[i]!.breadth = n;
  }
  return out;
}

function stat(s: Ev[]) {
  const n = s.length;
  if (n < 40) return null;
  const m = s.reduce((a, b) => a + b.ret, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b.ret - m) ** 2, 0) / n) || 1e-12;
  return { n, mean: m, win: s.filter((x) => x.ret > 0).length / n, t: (m / sd) * Math.sqrt(n) };
}

const spanCs = books[0]!.cs;
const T0 = spanCs[0]!.t, T1 = spanCs[spanCs.length - 1]!.t;
const CV = T0 + (T1 - T0) * 0.5, CH = T0 + (T1 - T0) * 0.75;
const days = (T1 - T0) / 86_400_000;
const BONF = 2.807 + 0.5 * Math.log(PLAYS.length / 50);

console.log(`${books.length} pairs (${books.map((b) => b.sym).join(" ")})`);
console.log(`${days.toFixed(0)} days · hold ${HOLD}h on time, no stop · ${(COST*10_000).toFixed(0)}bp`);
console.log(`${PLAYS.length} plays · bar |t| > ${Math.max(BONF, 2.5).toFixed(2)}\n`);
console.log("play               n    /mo    TRAIN     VAL      HOLD      all      t");
console.log("─".repeat(78));

const byPlay = new Map<string, Ev[]>();
for (const p of PLAYS) {
  const evs = events(p);
  byPlay.set(p.name, evs);
  const tr = stat(evs.filter((x) => x.t < CV)), v = stat(evs.filter((x) => x.t >= CV && x.t < CH));
  const h = stat(evs.filter((x) => x.t >= CH)), a = stat(evs);
  if (!a) { console.log(`${p.name.padEnd(18)}${String(evs.length).padStart(4)}  too few`); continue; }
  const f = (s: ReturnType<typeof stat>) => s ? `${(s.mean*100>=0?"+":"")+(s.mean*100).toFixed(2)}%`.padStart(8) : "     n/a";
  const stable = tr && v && h && tr.mean > 0 && v.mean > 0 && h.mean > 0;
  console.log(`${p.name.padEnd(18)}${String(a.n).padStart(4)} ${(a.n/days*30).toFixed(1).padStart(5)} ` +
    `${f(tr)}${f(v)}${f(h)}${f(a)} ${a.t.toFixed(1).padStart(5)}` +
    `${stable && a.t > 2.5 ? "  *** keep" : stable ? "  (stable)" : ""}`);
}

// Overlap: two plays firing the same bar on the same pair are one play twice.
console.log(`\nOVERLAP — share of each play's events also caught by wkLow wick60`);
const base = new Set(byPlay.get("wkLow wick60")!.map((e) => `${e.sym}@${e.t}`));
for (const p of PLAYS) {
  if (p.name === "wkLow wick60") continue;
  const evs = byPlay.get(p.name)!;
  if (!evs.length) continue;
  const dup = evs.filter((e) => base.has(`${e.sym}@${e.t}`)).length;
  console.log(`  ${p.name.padEnd(18)} ${((dup/evs.length)*100).toFixed(0).padStart(3)}% duplicate of the base play`);
}

// Combined book over the plays worth keeping.
/**
 * `cooldownH` refuses a new position within that many hours of the last entry.
 *
 * This is the fix implied by the clustering measurement: 73% of signals on 26
 * pairs arrive with 3+ others inside 6h, because a market-wide flush sweeps every
 * pair's weekly low at once. Without spacing, maxOpen fills with copies of one bet
 * and gross exposure is concentrated rather than diversified — which is why 26
 * pairs at 1.25x carries a 53% drawdown while 9 pairs carries 15%.
 */
function book(evs: Ev[], frac: number, maxOpen: number, cooldownH = 0) {
  const open: { exitT: number; ret: number; size: number }[] = [];
  let cash = 100, peak = 100, dd = 0, taken = 0, lastEntry = -Infinity;
  // takenRet/skipRet answer the question a positive per-trade mean cannot: WHICH
  // signals actually got a slot. If the taken mean is far below the population
  // mean, the slot queue is selecting losers and no amount of sizing fixes it.
  let takenRet = 0, skipped = 0, skipRet = 0;
  for (const e of [...evs].sort((a, b) => a.t - b.t)) {
    while (open.length && open[0]!.exitT <= e.t) {
      const o = open.shift()!; cash += o.size * o.ret;
      peak = Math.max(peak, cash); dd = Math.max(dd, (peak - cash) / peak);
    }
    if (open.length >= maxOpen || e.t - lastEntry < cooldownH * 3600_000) {
      skipped++; skipRet += e.ret; continue;
    }
    open.push({ exitT: e.t + HOLD * 3600_000, ret: e.ret, size: cash * frac });
    open.sort((a, b) => a.exitT - b.exitT); taken++; takenRet += e.ret; lastEntry = e.t;
  }
  for (const o of open) cash += o.size * o.ret;
  return { eq: cash, dd, taken, monthly: Math.pow(cash / 100, 30 / days) - 1,
    takenMean: taken ? takenRet / taken : 0, skipMean: skipped ? skipRet / skipped : 0 };
}

const keep = PLAYS.filter((p) => {
  const evs = byPlay.get(p.name)!;
  const tr = stat(evs.filter((x) => x.t < CV)), v = stat(evs.filter((x) => x.t >= CV && x.t < CH));
  const h = stat(evs.filter((x) => x.t >= CH)), a = stat(evs);
  return tr && v && h && a && tr.mean > 0 && v.mean > 0 && h.mean > 0 && a.t > 2.5;
});
console.log(`\nKEEPING ${keep.length} play(s): ${keep.map((p) => p.name).join(", ") || "none"}`);
const combinedRaw = keep.flatMap((p) => byPlay.get(p.name)!);
// de-duplicate: same pair + same bar counts once
const seen = new Set<string>();
const combined = combinedRaw.sort((a, b) => a.t - b.t).filter((e) => {
  const k = `${e.sym}@${e.t}`; if (seen.has(k)) return false; seen.add(k); return true;
});
console.log(`combined ${combined.length} unique events (${(combined.length/days*30).toFixed(1)}/month)`);
const baseEvs = byPlay.get("wkLow wick60")!;
// Clustering: how many of the base play's signals land within 6h of another one?
// Correlated pairs all sweep their weekly lows on the same market-wide flush, so
// more pairs can mean the SAME bet repeated rather than more independent bets.
{
  const ts = baseEvs.map((e) => e.t).sort((a, b) => a - b);
  let clustered = 0;
  const WIN = 6 * 3600_000;
  for (let i = 0; i < ts.length; i++) {
    const near = ts.filter((x) => Math.abs(x - ts[i]!) <= WIN).length - 1;
    if (near >= 3) clustered++;
  }
  console.log(`\nCLUSTERING — base play, ${books.length} pairs`);
  console.log(`  ${((clustered/ts.length)*100).toFixed(0)}% of signals have >=3 other signals within 6h`);
  console.log(`  (correlated pairs sweep the same weekly lows on one market-wide flush,`);
  console.log(`   so maxOpen fills with near-identical bets rather than diversified ones)`);
}
console.log(`\nBASE PLAY with a COOLDOWN between entries (the fix for clustering)`);
console.log("  exposure   cooldown    $100 ->   %/mo    DD   trades   taken   skipped");
for (const [frac, mo] of [[0.25, 5], [0.5, 5], [1.0, 5]] as const) {
  for (const cd of [0, 6, 12, 24, 48]) {
    const b = book(baseEvs, frac, mo, cd);
    console.log(`  ${(frac*mo).toFixed(2)}x        ${String(cd).padStart(2)}h     ` +
      `$${b.eq.toFixed(0).padStart(7)}  ${(b.monthly*100>=0?"+":"")+(b.monthly*100).toFixed(2)}%  ${(b.dd*100).toFixed(0).padStart(3)}%   ${String(b.taken).padStart(4)}  ` +
      `${((b.takenMean*100>=0?"+":"")+(b.takenMean*100).toFixed(2)+"%").padStart(7)}  ${((b.skipMean*100>=0?"+":"")+(b.skipMean*100).toFixed(2)+"%").padStart(7)}`);
  }
}
console.log(`\nCOMBINED plays, best cooldown`);
for (const [frac, mo] of [[0.25, 5], [0.5, 5]] as const) {
  for (const cd of [0, 12, 24]) {
    const b = book(combined, frac, mo, cd);
    console.log(`  ${(frac*mo).toFixed(2)}x        ${String(cd).padStart(2)}h     ` +
      `$${b.eq.toFixed(0).padStart(7)}  ${(b.monthly*100>=0?"+":"")+(b.monthly*100).toFixed(2)}%  ${(b.dd*100).toFixed(0).padStart(3)}%   ${b.taken}`);
  }
}

/**
 * WHY THE BOOK LOSES WHILE THE PLAY WINS.
 *
 * The taken/skipped columns above are the whole story: first-come slot
 * allocation takes the signals averaging about -0.1% and refuses the ones
 * averaging about +1.5%. It is not sizing, it is not cost, and a cooldown does
 * not fix it (the taken mean stays negative at every cooldown) because a
 * cooldown still admits the EARLIEST signal in each window.
 *
 * The mechanism: a market-wide flush sweeps every pair's weekly low, but not at
 * the same instant. The pairs that go first sweep on the way down, get the five
 * slots, and hold them for 24h. The pairs that sweep at the actual low arrive to
 * find the book full and are refused. First-come buys the top of the flush and
 * turns away the bottom.
 *
 * So the fix is not spacing entries, it is ORDERING them - and the ordering has
 * to be knowable at entry. Two candidates, both strictly backward-looking:
 *   DEPTH    - how far past the weekly low this bar pierced, in ATR. Later
 *              sweeps in a flush are deeper.
 *   BREADTH  - how many other pairs already swept in the preceding 6h. A signal
 *              arriving late in a broad flush has high breadth by construction,
 *              which is exactly the population the queue was refusing.
 * If the refused winners are identifiable this way, gating on it recovers them.
 */
function bucket(evs: Ev[], label: string, key: (e: Ev) => number, edges: number[]) {
  console.log(`\n${label}`);
  console.log("  bucket          n    mean      t");
  for (let i = 0; i < edges.length; i++) {
    const lo = edges[i]!, hi = edges[i + 1] ?? Infinity;
    const s = evs.filter((e) => key(e) >= lo && key(e) < hi);
    const st = stat(s);
    const name = hi === Infinity ? `>= ${lo}` : `${lo} - ${hi}`;
    if (!st) { console.log(`  ${name.padEnd(12)}${String(s.length).padStart(5)}    too few`); continue; }
    console.log(`  ${name.padEnd(12)}${String(st.n).padStart(5)}  ${((st.mean*100>=0?"+":"")+(st.mean*100).toFixed(2)+"%").padStart(7)}  ${st.t.toFixed(1).padStart(5)}`);
  }
}
bucket(baseEvs, "BREADTH — other pairs swept in the preceding 6h", (e) => e.breadth, [0, 1, 3, 6, 10]);
bucket(baseEvs, "DEPTH — ATR past the weekly low", (e) => e.depthAtr, [0, 0.25, 0.5, 1, 2]);

/** Same book, but a signal must clear the causal gates before it can take a slot. */
function gated(evs: Ev[], frac: number, maxOpen: number, breadthMin: number, depthMin: number, cooldownH = 0) {
  return book(evs.filter((e) => e.breadth >= breadthMin && e.depthAtr >= depthMin), frac, maxOpen, cooldownH);
}
console.log(`\nGATED BOOK — 26 pairs, base play, 1.25x gross (0.25 x 5 slots)`);
console.log("  breadth  depth   cool    $100 ->   %/mo    DD   trades   taken");
for (const bMin of [0, 3, 6, 10]) {
  for (const dMin of [0, 0.5]) {
    for (const cd of [0, 24]) {
      const b = gated(baseEvs, 0.25, 5, bMin, dMin, cd);
      if (b.taken < 30) continue;
      console.log(`  ${String(bMin).padStart(4)}    ${dMin.toFixed(2)}   ${String(cd).padStart(2)}h   ` +
        `$${b.eq.toFixed(0).padStart(7)}  ${(b.monthly*100>=0?"+":"")+(b.monthly*100).toFixed(2)}%  ${(b.dd*100).toFixed(0).padStart(3)}%   ${String(b.taken).padStart(4)}  ` +
        `${((b.takenMean*100>=0?"+":"")+(b.takenMean*100).toFixed(2)+"%").padStart(7)}`);
    }
  }
}
console.log(`\nGATED BOOK — best gate, swept across exposure`);
for (const [frac, mo] of [[0.25, 5], [0.5, 5], [1.0, 5]] as const) {
  const b = gated(baseEvs, frac, mo, 6, 0.5, 0);
  console.log(`  ${(frac*mo).toFixed(2)}x  $${b.eq.toFixed(0).padStart(7)}  ${(b.monthly*100>=0?"+":"")+(b.monthly*100).toFixed(2)}%  ${(b.dd*100).toFixed(0).padStart(3)}%   ${b.taken} trades  taken ${((b.takenMean*100>=0?"+":"")+(b.takenMean*100).toFixed(2))}%`);
}

/**
 * IS BREADTH REAL, OR IS IT THREE CRASH DAYS?
 *
 * breadth >= 10 means "ten other pairs swept their weekly low in the last 6h",
 * which by construction only happens in a market-wide flush. If the sample is a
 * handful of such flushes, n = 235 is really n = a-handful and the t of 9.1 is
 * the correlation artefact this project has already been burned by once.
 *
 * So: count distinct episodes (signals within 24h of each other are ONE episode),
 * cluster the standard error on the episode, and split three ways. A gate that
 * survives all three is worth something; one that does not is a crash anecdote.
 */
function episodes(evs: Ev[]) {
  const ts = [...evs].sort((a, b) => a.t - b.t);
  const groups: Ev[][] = [];
  for (const e of ts) {
    const last = groups[groups.length - 1];
    if (last && e.t - last[last.length - 1]!.t <= 24 * 3600_000) last.push(e);
    else groups.push([e]);
  }
  return groups;
}
function clustered(evs: Ev[]) {
  const g = episodes(evs);
  // Each episode contributes its mean; the t is over episodes, not over trades.
  const ms = g.map((x) => x.reduce((a, b) => a + b.ret, 0) / x.length);
  const n = ms.length;
  const m = ms.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(ms.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1)) || 1e-12;
  return { episodes: n, mean: m, t: (m / sd) * Math.sqrt(n) };
}
console.log(`\nBREADTH GATES — episode-clustered, and split three ways`);
console.log("  gate        n   episodes   naive t   clustered t    TRAIN     VAL     HOLD");
for (const bMin of [0, 3, 6, 10]) {
  const s = baseEvs.filter((e) => e.breadth >= bMin);
  const a = stat(s), c = clustered(s);
  const tr = stat(s.filter((x) => x.t < CV)), v = stat(s.filter((x) => x.t >= CV && x.t < CH));
  const h = stat(s.filter((x) => x.t >= CH));
  const f = (x: ReturnType<typeof stat>) => x ? `${(x.mean*100>=0?"+":"")+(x.mean*100).toFixed(2)}%`.padStart(8) : "     n/a";
  console.log(`  >=${String(bMin).padStart(2)}  ${String(s.length).padStart(6)}   ${String(c.episodes).padStart(6)}   ` +
    `${(a?.t ?? 0).toFixed(1).padStart(7)}   ${c.t.toFixed(1).padStart(11)}  ${f(tr)}${f(v)}${f(h)}`);
}
console.log(`\n  (episodes = signal clusters >24h apart. A gate whose n collapses to a`);
console.log(`   few episodes is one crash repeated, not a repeatable setup.)`);

// How much of the >=10 bucket's return comes from its single best episode?
{
  const s = baseEvs.filter((e) => e.breadth >= 10);
  const g = episodes(s).map((x) => ({ n: x.length, m: x.reduce((a, b) => a + b.ret, 0) / x.length,
    day: new Date(x[0]!.t).toISOString().slice(0, 10) }));
  g.sort((a, b) => b.m * b.n - a.m * a.n);
  const total = g.reduce((a, b) => a + b.m * b.n, 0);
  console.log(`\n  breadth>=10 top episodes by contribution (of ${total.toFixed(2)} total R-sum):`);
  for (const e of g.slice(0, 6)) {
    console.log(`    ${e.day}  n=${String(e.n).padStart(3)}  mean ${((e.m*100>=0?"+":"")+(e.m*100).toFixed(2)+"%").padStart(7)}  ` +
      `${((e.m*e.n/total)*100).toFixed(0)}% of the total`);
  }
  console.log(`    ${g.length} episodes in all; losing episodes: ${g.filter((x) => x.m < 0).length}`);
}

/**
 * VERDICT SWEEP.
 *
 * breadth >= 10 has the biggest numbers and the worst evidence: 34 episodes, 62%
 * of the return in three days, clustered t 2.8. breadth >= 3 is the gate that
 * actually survives - 112 episodes, clustered t 3.7, the highest of any gate, and
 * it holds across all three splits. That is the one to size, so sweep it against
 * the ungated book at matched exposure.
 */
console.log(`\nVERDICT — breadth >= 3 gate vs ungated, matched exposure, ${books.length} pairs`);
console.log("  exposure   gate            $100 ->   %/mo    DD   trades   taken");
for (const [frac, mo] of [[0.25, 5], [0.5, 5], [1.0, 5]] as const) {
  for (const [label, bMin, dMin] of [["none", 0, 0], ["breadth>=3", 3, 0], ["breadth>=3 +depth", 3, 0.5]] as const) {
    const b = gated(baseEvs, frac, mo, bMin, dMin, 0);
    console.log(`  ${(frac*mo).toFixed(2)}x      ${label.padEnd(18)}` +
      `$${b.eq.toFixed(0).padStart(7)}  ${(b.monthly*100>=0?"+":"")+(b.monthly*100).toFixed(2)}%  ${(b.dd*100).toFixed(0).padStart(3)}%   ${String(b.taken).padStart(4)}  ` +
      `${((b.takenMean*100>=0?"+":"")+(b.takenMean*100).toFixed(2)+"%").padStart(7)}`);
  }
}

/**
 * BREADTH WIDE, POSITIONS NARROW.
 *
 * The gate and the book want different universes, and conflating them was a
 * specification error: "breadth >= 3" means 3 of 8 others on a 9-pair run but
 * 3 of 25 on a 26-pair run, which are not the same test.
 *
 * Breadth is a market-state reading, so it should be measured across every pair
 * there is data for - that is also the sample where the gate is testable
 * (112 episodes, clustered t 3.7, all three splits positive). The book is a
 * different question, and the majors win it: the wider universe dilutes the
 * per-trade edge from +1.00% to +0.61% because the edge lives in the majors.
 *
 * So: read breadth on all 26, take positions only in the majors. Run this with
 * no ONLY filter - the narrowing happens here, after breadth is computed.
 */
const MAJORS = new Set(["BTC", "ETH", "SOL", "XRP", "XLM", "BNB", "DOGE", "AVAX", "LINK"]);
if (!ONLY && books.some((b) => MAJORS.has(b.sym))) {
  const wide = baseEvs.filter((e) => MAJORS.has(e.sym));
  const a = stat(wide), c = clustered(wide);
  console.log(`\nBREADTH WIDE (26 pairs), POSITIONS NARROW (${[...MAJORS].filter((m) => books.some((b) => b.sym === m)).length} majors)`);
  console.log(`  ${a?.n} major signals · per-trade ${((a!.mean*100)).toFixed(2)}% · naive t ${a!.t.toFixed(1)} · ${c.episodes} episodes · clustered t ${c.t.toFixed(1)}`);
  for (const bMin of [0, 2, 3, 5]) {
    const s = wide.filter((e) => e.breadth >= bMin);
    const st = stat(s), cl = clustered(s);
    const tr = stat(s.filter((x) => x.t < CV)), v = stat(s.filter((x) => x.t >= CV && x.t < CH));
    const h = stat(s.filter((x) => x.t >= CH));
    const f = (x: ReturnType<typeof stat>) => x ? `${(x.mean*100>=0?"+":"")+(x.mean*100).toFixed(2)}%`.padStart(8) : "     n/a";
    console.log(`  breadth>=${bMin}  n=${String(s.length).padStart(4)}  ep=${String(cl.episodes).padStart(3)}  ` +
      `mean ${((st?.mean??0)*100).toFixed(2)}%  clustered t ${cl.t.toFixed(1).padStart(4)}   TRAIN${f(tr)} VAL${f(v)} HOLD${f(h)}`);
  }
  // DD at 5x fell to 20%, so there is headroom worth measuring rather than assuming.
  console.log(`\n  exposure sweep, breadth>=3, positions in majors only`);
  console.log("    gross     $100 ->    %/mo     DD   trades");
  for (const [frac, mo] of [[0.25, 5], [0.5, 5], [1.0, 5], [2.0, 5], [3.0, 5], [4.0, 5]] as const) {
    const b = gated(wide, frac, mo, 3, 0, 0);
    // The book lets cash go negative; a real isolated-margin account is closed out
    // long before that. Anything at or below zero is ruin, not a return.
    if (b.eq <= 0 || b.dd >= 1) {
      console.log(`    ${(frac*mo).toFixed(2).padStart(5)}x     RUIN — drawdown reached 100%, account closed out`);
      continue;
    }
    console.log(`    ${(frac*mo).toFixed(2).padStart(5)}x  $${b.eq.toFixed(0).padStart(8)}  ${((b.monthly*100>=0?"+":"")+(b.monthly*100).toFixed(2)+"%").padStart(7)}  ${(b.dd*100).toFixed(0).padStart(4)}%   ${b.taken}`);
  }
}
