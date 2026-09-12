/**
 * Candidate strategy families NOT in ict.ts, for research.
 *
 * Everything here is strictly causal: a signal at bar `i` is built only from
 * bars 0..i. That is deliberate — board row 20 records that scanIct emits 71% of
 * its signals using bars that had not happened yet, and nothing new should
 * inherit that.
 *
 * Signals use the same shape as IctSignal so they run through the already-honest
 * simulateIct (costs, gap fills, intra-bar sequencing). `setup` is a free string
 * here for grouping in the research harness; nothing is plumbed into the app
 * until it earns it.
 */
import { atr, nyParts, rsiWilder, type IctSignal } from "./ict.ts";
import type { Candle } from "./types.ts";

export const MIN_STOP_ATR_RESEARCH = 0.25;
const MAX_RISK_PCT = 0.03;

/** Same discipline pack() applies: no absurd stop in either direction. */
function build(
  i: number,
  c: Candle,
  side: "long" | "short",
  setup: string,
  entry: number,
  stop: number,
  rr: number,
  note: string,
  a: number,
): IctSignal | null {
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || risk <= 0) return null;
  if (risk / entry > MAX_RISK_PCT) return null;
  if (a > 0 && risk < a * MIN_STOP_ATR_RESEARCH) return null;
  const dir = side === "long" ? 1 : -1;
  const target = entry + dir * rr * risk;
  if (side === "long" && target <= entry) return null;
  if (side === "short" && target >= entry) return null;
  return { i, t: c.t, side, setup: setup as IctSignal["setup"], entry, stop, target, note };
}

// ───────────────────────────── volume profile ─────────────────────────────

export interface Profile {
  poc: number;
  vah: number;
  val: number;
}

/**
 * Volume profile over the trailing `look` bars, binned into `bins` price levels.
 * Each bar's volume is spread evenly across the levels its range covers, which
 * is the standard approximation when you only have OHLCV and not tick data.
 * POC is the highest-volume level; the value area is the 70% of volume nearest
 * the POC.
 */
export function profile(cs: Candle[], i: number, look = 96, bins = 48): Profile | null {
  const from = Math.max(0, i - look + 1);
  if (i - from < 20) return null;
  let hi = -Infinity, lo = Infinity;
  for (let k = from; k <= i; k++) {
    hi = Math.max(hi, cs[k]!.h);
    lo = Math.min(lo, cs[k]!.l);
  }
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const vol = new Array<number>(bins).fill(0);
  for (let k = from; k <= i; k++) {
    const c = cs[k]!;
    const a = Math.max(0, Math.min(bins - 1, Math.floor((c.l - lo) / step)));
    const b = Math.max(0, Math.min(bins - 1, Math.floor((c.h - lo) / step)));
    const span = b - a + 1;
    const per = (c.v > 0 ? c.v : 1) / span;
    for (let x = a; x <= b; x++) vol[x]! += per;
  }
  let pocIdx = 0;
  for (let x = 1; x < bins; x++) if (vol[x]! > vol[pocIdx]!) pocIdx = x;
  const total = vol.reduce((s, v) => s + v, 0);
  // Grow outward from the POC until 70% of volume is enclosed.
  let loIdx = pocIdx, hiIdx = pocIdx, acc = vol[pocIdx]!;
  while (acc < total * 0.7 && (loIdx > 0 || hiIdx < bins - 1)) {
    const down = loIdx > 0 ? vol[loIdx - 1]! : -1;
    const up = hiIdx < bins - 1 ? vol[hiIdx + 1]! : -1;
    if (up >= down) { hiIdx++; acc += Math.max(0, up); }
    else { loIdx--; acc += Math.max(0, down); }
  }
  const mid = (x: number) => lo + (x + 0.5) * step;
  return { poc: mid(pocIdx), vah: mid(hiIdx), val: mid(loIdx) };
}

/**
 * POC family.
 *  - reversion: price stretched well beyond the value area, trade back to POC.
 *  - rejection: price tags the POC and closes away from it, trade the rejection.
 *  - breakout: close decisively outside the value area, trade continuation.
 */
export function scanPoc(cs: Candle[], which: "rev" | "rej" | "brk" | "all" = "all"): IctSignal[] {
  const out: IctSignal[] = [];
  for (let i = 40; i < cs.length; i++) {
    const c = cs[i]!, prev = cs[i - 1]!;
    const p = profile(cs, i);
    if (!p) continue;
    const a = atr(cs, i);
    if (!(a > 0)) continue;

    if (which === "rev" || which === "all") {
      // Stretched above the value area -> short back toward the POC.
      if (c.c > p.vah + a * 1.2 && c.c < prev.c) {
        const stop = Math.max(c.h, prev.h) + a * 0.3;
        const risk = stop - c.c;
        if (risk > 0) {
          const rr = (c.c - p.poc) / risk;
          if (rr >= 1.2) out.push(build(i, c, "short", "poc-rev", c.c, stop, Math.min(rr, 3), "stretched above VAH · revert to POC", a)!);
        }
      }
      if (c.c < p.val - a * 1.2 && c.c > prev.c) {
        const stop = Math.min(c.l, prev.l) - a * 0.3;
        const risk = c.c - stop;
        if (risk > 0) {
          const rr = (p.poc - c.c) / risk;
          if (rr >= 1.2) out.push(build(i, c, "long", "poc-rev", c.c, stop, Math.min(rr, 3), "stretched below VAL · revert to POC", a)!);
        }
      }
    }

    if (which === "rej" || which === "all") {
      const tagged = c.l <= p.poc && c.h >= p.poc;
      if (tagged && c.c > p.poc && c.c > c.o) {
        out.push(build(i, c, "long", "poc-rej", c.c, Math.min(c.l, p.poc - a * 0.2), 2, "POC tagged · closed above · long", a)!);
      }
      if (tagged && c.c < p.poc && c.c < c.o) {
        out.push(build(i, c, "short", "poc-rej", c.c, Math.max(c.h, p.poc + a * 0.2), 2, "POC tagged · closed below · short", a)!);
      }
    }

    if (which === "brk" || which === "all") {
      if (prev.c <= p.vah && c.c > p.vah + a * 0.15) {
        out.push(build(i, c, "long", "poc-brk", c.c, p.poc, 2, "value-area breakout up", a)!);
      }
      if (prev.c >= p.val && c.c < p.val - a * 0.15) {
        out.push(build(i, c, "short", "poc-brk", c.c, p.poc, 2, "value-area breakdown", a)!);
      }
    }
  }
  return out.filter(Boolean);
}

// ───────────────────────── session open / close ─────────────────────────

interface Range { h: number; l: number; bars: number }

/** Opening range for a given NY hour:minute window, built causally. */
function openingRange(cs: Candle[], i: number, startH: number, startM: number, mins: number): Range | null {
  const day = nyParts(cs[i]!.t).day;
  let h = -Infinity, l = Infinity, bars = 0;
  for (let k = i; k >= 0 && k > i - 40; k--) {
    const p = nyParts(cs[k]!.t);
    if (p.day !== day) break;
    const mofd = p.h * 60 + p.m;
    const from = startH * 60 + startM;
    if (mofd < from || mofd >= from + mins) continue;
    h = Math.max(h, cs[k]!.h);
    l = Math.min(l, cs[k]!.l);
    bars++;
  }
  return bars >= 2 && h > l ? { h, l, bars } : null;
}

function inNyWindow(t: number, fromH: number, fromM: number, toH: number, toM: number): boolean {
  const p = nyParts(t);
  const m = p.h * 60 + p.m;
  return m >= fromH * 60 + fromM && m < toH * 60 + toM;
}

/**
 * NY open family. The cash open is 09:30 NY; the first 30 minutes sets the
 * opening range, and 10:00-11:30 is where it is broken or faded.
 *  - orb:  break of the opening range, continuation.
 *  - fade: sweep of the opening range extreme then close back inside.
 */
export function scanNyOpen(cs: Candle[], which: "orb" | "fade" | "all" = "all"): IctSignal[] {
  const out: IctSignal[] = [];
  for (let i = 40; i < cs.length; i++) {
    const c = cs[i]!;
    if (!inNyWindow(c.t, 10, 0, 11, 30)) continue;
    const or = openingRange(cs, i, 9, 30, 30);
    if (!or) continue;
    const a = atr(cs, i);
    if (!(a > 0)) continue;
    const mid = (or.h + or.l) / 2;

    if (which === "orb" || which === "all") {
      if (c.c > or.h && cs[i - 1]!.c <= or.h) {
        out.push(build(i, c, "long", "nyopen-orb", c.c, Math.min(mid, c.c - a * 0.4), 2, "NY opening range break up", a)!);
      }
      if (c.c < or.l && cs[i - 1]!.c >= or.l) {
        out.push(build(i, c, "short", "nyopen-orb", c.c, Math.max(mid, c.c + a * 0.4), 2, "NY opening range break down", a)!);
      }
    }
    if (which === "fade" || which === "all") {
      if (c.h > or.h && c.c < or.h) {
        out.push(build(i, c, "short", "nyopen-fade", c.c, c.h + a * 0.25, 2, "NY OR high swept · closed back in", a)!);
      }
      if (c.l < or.l && c.c > or.l) {
        out.push(build(i, c, "long", "nyopen-fade", c.c, c.l - a * 0.25, 2, "NY OR low swept · closed back in", a)!);
      }
    }
  }
  return out.filter(Boolean);
}

/**
 * NY close family: the 15:00-16:00 NY hour. Tests whether the day's extreme
 * being swept late reverses into the close, and whether late trend persists.
 */
export function scanNyClose(cs: Candle[], which: "rev" | "drift" | "all" = "all"): IctSignal[] {
  const out: IctSignal[] = [];
  for (let i = 40; i < cs.length; i++) {
    const c = cs[i]!;
    if (!inNyWindow(c.t, 15, 0, 16, 0)) continue;
    const day = nyParts(c.t).day;
    let dh = -Infinity, dl = Infinity, open = NaN;
    for (let k = i - 1; k >= 0 && k > i - 100; k--) {
      const p = nyParts(cs[k]!.t);
      if (p.day !== day) break;
      dh = Math.max(dh, cs[k]!.h);
      dl = Math.min(dl, cs[k]!.l);
      open = cs[k]!.o;
    }
    if (!Number.isFinite(dh) || !Number.isFinite(dl) || !Number.isFinite(open)) continue;
    const a = atr(cs, i);
    if (!(a > 0)) continue;

    if (which === "rev" || which === "all") {
      if (c.h > dh && c.c < dh) {
        out.push(build(i, c, "short", "nyclose-rev", c.c, c.h + a * 0.25, 2, "day high swept into the close", a)!);
      }
      if (c.l < dl && c.c > dl) {
        out.push(build(i, c, "long", "nyclose-rev", c.c, c.l - a * 0.25, 2, "day low swept into the close", a)!);
      }
    }
    if (which === "drift" || which === "all") {
      const up = c.c > open && c.c > (dh + dl) / 2;
      const dn = c.c < open && c.c < (dh + dl) / 2;
      if (up && c.c > cs[i - 1]!.c) {
        out.push(build(i, c, "long", "nyclose-drift", c.c, c.c - a * 0.8, 1.5, "up day · late continuation", a)!);
      }
      if (dn && c.c < cs[i - 1]!.c) {
        out.push(build(i, c, "short", "nyclose-drift", c.c, c.c + a * 0.8, 1.5, "down day · late continuation", a)!);
      }
    }
  }
  return out.filter(Boolean);
}

/**
 * RSI divergence, isolated so regular and hidden can be measured apart. ict.ts
 * folds both into one `div` setup, which hides which half carries the result.
 * Causal: pivots are confirmed with bars to their right that are still <= i.
 */
export function scanDiv(cs: Candle[], kind: "regular" | "hidden" | "all" = "all"): IctSignal[] {
  const out: IctSignal[] = [];
  const rsi = rsiWilder(cs);
  const piv: { i: number; price: number; hi: boolean }[] = [];
  for (let i = 2; i < cs.length - 2; i++) {
    const c = cs[i]!;
    if (c.h > cs[i - 1]!.h && c.h > cs[i - 2]!.h && c.h > cs[i + 1]!.h && c.h > cs[i + 2]!.h) piv.push({ i, price: c.h, hi: true });
    if (c.l < cs[i - 1]!.l && c.l < cs[i - 2]!.l && c.l < cs[i + 1]!.l && c.l < cs[i + 2]!.l) piv.push({ i, price: c.l, hi: false });
  }
  for (let i = 40; i < cs.length; i++) {
    const c = cs[i]!;
    const a = atr(cs, i);
    if (!(a > 0)) continue;
    // A pivot at j is only known at j+2, so require j+2 <= i.
    const seen = piv.filter((p) => p.i + 2 <= i && p.i >= i - 60);
    const his = seen.filter((p) => p.hi).slice(-2);
    const los = seen.filter((p) => !p.hi).slice(-2);

    if (his.length === 2 && i - his[1]!.i <= 3) {
      const [p, q] = his, rp = rsi[p!.i] ?? 50, rq = rsi[q!.i] ?? 50;
      const regular = q!.price > p!.price && rq < rp;
      const hidden = q!.price < p!.price && rq > rp;
      const want = kind === "all" ? regular || hidden : kind === "regular" ? regular : hidden;
      if (want) {
        out.push(build(i, c, "short", regular ? "div-reg" : "div-hid", c.c, q!.price + a * 0.2, 2,
          regular ? "regular bearish div" : "hidden bearish div", a)!);
      }
    }
    if (los.length === 2 && i - los[1]!.i <= 3) {
      const [p, q] = los, rp = rsi[p!.i] ?? 50, rq = rsi[q!.i] ?? 50;
      const regular = q!.price < p!.price && rq > rp;
      const hidden = q!.price > p!.price && rq < rp;
      const want = kind === "all" ? regular || hidden : kind === "regular" ? regular : hidden;
      if (want) {
        out.push(build(i, c, "long", regular ? "div-reg" : "div-hid", c.c, q!.price - a * 0.2, 2,
          regular ? "regular bullish div" : "hidden bullish div", a)!);
      }
    }
  }
  return out.filter(Boolean);
}
