import type { Candle, ClosedTrade, SetupKind, SetupOdds } from "./types";

const NY_OFFSET_MS = 4 * 3600_000; // EDT in September

export function nyParts(t: number): { h: number; m: number; day: string } {
  const shifted = t - NY_OFFSET_MS;
  const d = new Date(shifted);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const day = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  return { h, m, day };
}

export function nyHour(t: number): number {
  const p = nyParts(t);
  return p.h + p.m / 60;
}

export function inWindow(t: number, startH: number, endH: number): boolean {
  const h = nyHour(t);
  return h >= startH && h < endH;
}

export function isLondon(t: number): boolean {
  return inWindow(t, 2, 5);
}
export function isNyAm(t: number): boolean {
  return inWindow(t, 7, 10);
}
export function isSilver(t: number): boolean {
  return inWindow(t, 10, 11);
}
export function isAsia(t: number): boolean {
  const h = nyHour(t);
  return h >= 20 || h < 2;
}
export function isNyPm(t: number): boolean {
  return inWindow(t, 13.5, 16);
}
export function inKill(t: number): boolean {
  return isLondon(t) || isNyAm(t) || isSilver(t) || isNyPm(t);
}

export interface Swing {
  i: number;
  t: number;
  price: number;
  kind: "high" | "low";
}

export function swings(cs: Candle[], left = 2, right = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = left; i < cs.length - right; i++) {
    const c = cs[i]!;
    let isH = true;
    let isL = true;
    for (let k = i - left; k <= i + right; k++) {
      if (k === i) continue;
      if (cs[k]!.h >= c.h) isH = false;
      if (cs[k]!.l <= c.l) isL = false;
    }
    if (isH) out.push({ i, t: c.t, price: c.h, kind: "high" });
    if (isL) out.push({ i, t: c.t, price: c.l, kind: "low" });
  }
  return out;
}

export interface FVG {
  i: number;
  t: number;
  dir: 1 | -1;
  top: number;
  bot: number;
}

export function detectFvgs(cs: Candle[]): FVG[] {
  const out: FVG[] = [];
  for (let i = 2; i < cs.length; i++) {
    const a = cs[i - 2]!;
    const c = cs[i]!;
    if (c.l > a.h) {
      out.push({ i, t: c.t, dir: 1, top: c.l, bot: a.h });
    } else if (c.h < a.l) {
      out.push({ i, t: c.t, dir: -1, top: a.l, bot: c.h });
    }
  }
  return out;
}

export interface OrderBlock {
  i: number;
  t: number;
  dir: 1 | -1;
  top: number;
  bot: number;
}

/** Last opposite candle before a displacement close. */
export function detectObs(cs: Candle[]): OrderBlock[] {
  const out: OrderBlock[] = [];
  for (let i = 3; i < cs.length; i++) {
    const c = cs[i]!;
    const body = Math.abs(c.c - c.o);
    const range = c.h - c.l || 1;
    if (body / range < 0.55) continue;
    if (c.c > c.o && c.c > cs[i - 1]!.h && c.c > cs[i - 2]!.h) {
      for (let k = i - 1; k >= Math.max(0, i - 6); k--) {
        const prev = cs[k]!;
        if (prev.c < prev.o) {
          out.push({ i: k, t: prev.t, dir: 1, top: prev.h, bot: prev.l });
          break;
        }
      }
    }
    if (c.c < c.o && c.c < cs[i - 1]!.l && c.c < cs[i - 2]!.l) {
      for (let k = i - 1; k >= Math.max(0, i - 6); k--) {
        const prev = cs[k]!;
        if (prev.c > prev.o) {
          out.push({ i: k, t: prev.t, dir: -1, top: prev.h, bot: prev.l });
          break;
        }
      }
    }
  }
  return out;
}

interface DayRange {
  day: string;
  asiaH: number;
  asiaL: number;
  asiaReady: boolean;
}

function buildAsia(cs: Candle[]): Map<string, DayRange> {
  const map = new Map<string, DayRange>();
  for (const c of cs) {
    const p = nyParts(c.t);
    let day = p.day;
    if (p.h >= 20) {
      const shifted = c.t - NY_OFFSET_MS + 24 * 3600_000;
      const d = new Date(shifted);
      day = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    }
    if (!isAsia(c.t)) continue;
    let rec = map.get(day);
    if (!rec) {
      rec = { day, asiaH: c.h, asiaL: c.l, asiaReady: true };
      map.set(day, rec);
    } else {
      rec.asiaH = Math.max(rec.asiaH, c.h);
      rec.asiaL = Math.min(rec.asiaL, c.l);
    }
  }
  return map;
}

function hourRange(cs: Candle[], day: string, startH: number, endH: number): { h: number; l: number } | null {
  let h = -Infinity;
  let l = Infinity;
  for (const c of cs) {
    if (nyParts(c.t).day !== day) continue;
    const hr = nyHour(c.t);
    if (hr < startH || hr >= endH) continue;
    h = Math.max(h, c.h);
    l = Math.min(l, c.l);
  }
  if (!Number.isFinite(h) || !Number.isFinite(l) || h <= l) return null;
  return { h, l };
}

/** Prior ~5h slope. 1 bull, -1 bear, 0 no trade. */
export function htfBias(cs: Candle[], i: number): 1 | -1 | 0 {
  if (i < 24) return 0;
  const a = cs[i - 24]!.c;
  const b = cs[i]!.c;
  if (a <= 0) return 0;
  const ch = (b - a) / a;
  if (ch > 0.0035) return 1;
  if (ch < -0.0035) return -1;
  return 0;
}

function atr(cs: Candle[], i: number, n = 14): number {
  const start = Math.max(1, i - n);
  let s = 0;
  let k = 0;
  for (let j = start; j <= i; j++) {
    const c = cs[j]!;
    const prev = cs[j - 1] ?? c;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
    s += tr;
    k += 1;
  }
  return k ? s / k : cs[i]!.h - cs[i]!.l;
}

/** CISD: close through the candle series that made the swept swing. */
function cisd(cs: Candle[], sweepI: number, side: "long" | "short"): { ok: boolean; i: number; fvg?: FVG } {
  const fvgs = detectFvgs(cs);
  const from = Math.max(0, sweepI - 8);
  if (side === "long") {
    let seriesHigh = cs[sweepI]!.h;
    for (let k = from; k <= sweepI; k++) {
      if (cs[k]!.c <= cs[k]!.o) seriesHigh = Math.max(seriesHigh, cs[k]!.h);
    }
    for (let k = sweepI + 1; k <= Math.min(cs.length - 1, sweepI + 6); k++) {
      const n = cs[k]!;
      const body = Math.abs(n.c - n.o);
      const range = n.h - n.l || 1;
      if (n.c > seriesHigh && n.c > n.o && body / range >= 0.45 && body >= atr(cs, k) * 0.45) {
        const fvg = fvgs.find((f) => f.i === k && f.dir === 1);
        return { ok: true, i: k, fvg };
      }
    }
  } else {
    let seriesLow = cs[sweepI]!.l;
    for (let k = from; k <= sweepI; k++) {
      if (cs[k]!.c >= cs[k]!.o) seriesLow = Math.min(seriesLow, cs[k]!.l);
    }
    for (let k = sweepI + 1; k <= Math.min(cs.length - 1, sweepI + 6); k++) {
      const n = cs[k]!;
      const body = Math.abs(n.c - n.o);
      const range = n.h - n.l || 1;
      if (n.c < seriesLow && n.c < n.o && body / range >= 0.45 && body >= atr(cs, k) * 0.45) {
        const fvg = fvgs.find((f) => f.i === k && f.dir === -1);
        return { ok: true, i: k, fvg };
      }
    }
  }
  return { ok: false, i: sweepI };
}

function rsiWilder(cs: Candle[], n = 14): number[] {
  const out = Array.from({ length: cs.length }, () => 50);
  if (cs.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = cs[i]!.c - cs[i - 1]!.c;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let ag = gain / n;
  let al = loss / n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < cs.length; i++) {
    const d = cs[i]!.c - cs[i - 1]!.c;
    ag = (ag * (n - 1) + Math.max(0, d)) / n;
    al = (al * (n - 1) + Math.max(0, -d)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function overlap(aTop: number, aBot: number, bTop: number, bBot: number) {
  return Math.min(aTop, bTop) > Math.max(aBot, bBot);
}

function pack(
  i: number,
  t: number,
  side: "long" | "short",
  setup: SetupKind,
  entry: number,
  stop: number,
  target: number,
  note: string,
): IctSignal | null {
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || risk <= 0) return null;
  if (risk / entry > 0.03) return null;
  if (side === "long" && target <= entry) return null;
  if (side === "short" && target >= entry) return null;
  return { i, t, side, setup, entry, stop, target, note };
}

function twoR(side: "long" | "short", entry: number, stop: number, erl?: number): number {
  const risk = Math.abs(entry - stop);
  const raw = side === "long" ? entry + risk * 2 : entry - risk * 2;
  if (erl == null || !Number.isFinite(erl)) return raw;
  const erlR = Math.abs(erl - entry) / risk;
  if (erlR < 1.2) return raw;
  return side === "long" ? Math.max(erl, raw) : Math.min(erl, raw);
}

export interface IctSignal {
  i: number;
  t: number;
  side: "long" | "short";
  setup: SetupKind;
  entry: number;
  stop: number;
  target: number;
  note: string;
}

/**
 * TTrades stack on 15m:
 *  HTF bias, AMD London wick, Silver Bullet 10–11 on the 9am hour,
 *  CISD, order-block / unicorn (OB∩FVG), FVG CE, RSI regular + hidden divergence.
 *  Sweep alone is not a trade. Max 3 per NY day, 6 bars apart.
 */
export function scanIct(cs: Candle[]): IctSignal[] {
  if (cs.length < 48) return [];
  const asia = buildAsia(cs);
  const fvgs = detectFvgs(cs);
  const obs = detectObs(cs);
  const rsi = rsiWilder(cs);
  const sw = swings(cs, 3, 2);
  const signals: IctSignal[] = [];
  const londonRaid = new Map<string, "high" | "low">();
  const dayN = new Map<string, number>();
  const lastI = new Map<string, number>();

  const add = (sig: IctSignal | null) => {
    if (!sig) return;
    const day = nyParts(sig.t).day;
    if ((dayN.get(day) ?? 0) >= 3) return;
    const prev = lastI.get(day) ?? -99;
    if (sig.i - prev < 6) return;
    if (signals.some((x) => Math.abs(x.i - sig.i) < 4 && x.side === sig.side)) return;
    signals.push(sig);
    dayN.set(day, (dayN.get(day) ?? 0) + 1);
    lastI.set(day, sig.i);
  };

  for (let i = 24; i < cs.length - 2; i++) {
    const c = cs[i]!;
    const day = nyParts(c.t).day;
    const bias = htfBias(cs, i);
    const a = atr(cs, i);

    if (isLondon(c.t)) {
      const range = asia.get(day);
      if (range?.asiaReady) {
        if (c.h > range.asiaH && c.c < range.asiaH) londonRaid.set(day, "high");
        if (c.l < range.asiaL && c.c > range.asiaL) londonRaid.set(day, "low");
      }
    }

    if (isSilver(c.t)) {
      const nine = hourRange(cs, day, 9, 10);
      if (nine) {
        const sweptLow = c.l < nine.l && c.c > nine.l;
        const sweptHigh = c.h > nine.h && c.c < nine.h;
        const side: "long" | "short" | null = sweptLow ? "long" : sweptHigh ? "short" : null;
        if (side && !(bias === 1 && side === "short") && !(bias === -1 && side === "long")) {
          const conf = cisd(cs, i, side);
          if (conf.ok && conf.fvg) {
            const sweepPx = side === "long" ? Math.min(c.l, nine.l) : Math.max(c.h, nine.h);
            const entry = (conf.fvg.bot + conf.fvg.top) / 2;
            const stopPad = (nine.h - nine.l) * 0.08 || entry * 0.002;
            const stop = side === "long" ? sweepPx - stopPad : sweepPx + stopPad;
            add(
              pack(
                conf.i,
                cs[conf.i]!.t,
                side,
                "silver",
                entry,
                stop,
                twoR(side, entry, stop, side === "long" ? nine.h : nine.l),
                `SB 10–11 NY · swept 9am ${side === "long" ? "low" : "high"} · CISD · FVG`,
              ),
            );
          }
        }
      }
    }

    if (isLondon(c.t) || isNyAm(c.t)) {
      const range = asia.get(day);
      const raid = londonRaid.get(day);
      if (range?.asiaReady) {
        let side: "long" | "short" | null = null;
        let sweepPx = 0;
        let note = "";
        if (isLondon(c.t)) {
          const sweptLow = c.l < range.asiaL && c.c > range.asiaL;
          const sweptHigh = c.h > range.asiaH && c.c < range.asiaH;
          if (sweptLow && bias !== -1) {
            side = "long";
            sweepPx = Math.min(c.l, range.asiaL);
            note = "AMD · London raid on Asia low";
          } else if (sweptHigh && bias !== 1) {
            side = "short";
            sweepPx = Math.max(c.h, range.asiaH);
            note = "AMD · London raid on Asia high";
          }
        } else if (raid === "low" && bias !== -1 && c.c > range.asiaL) {
          side = "long";
          sweepPx = range.asiaL;
          note = "AMD · NY distribution after London SSL";
        } else if (raid === "high" && bias !== 1 && c.c < range.asiaH) {
          side = "short";
          sweepPx = range.asiaH;
          note = "AMD · NY distribution after London BSL";
        }
        if (side) {
          const conf = cisd(cs, i, side);
          if (conf.ok && (conf.fvg || isLondon(c.t))) {
            const entry = conf.fvg ? (conf.fvg.bot + conf.fvg.top) / 2 : cs[conf.i]!.c;
            const stopPad = (range.asiaH - range.asiaL) * 0.06 || entry * 0.0025;
            const stop = side === "long" ? sweepPx - stopPad : sweepPx + stopPad;
            add(
              pack(
                conf.i,
                cs[conf.i]!.t,
                side,
                isLondon(c.t) ? "amd" : "sweep",
                entry,
                stop,
                twoR(side, entry, stop, side === "long" ? range.asiaH : range.asiaL),
                `${note} · CISD${conf.fvg ? " · FVG" : ""} · ${bias === 1 ? "bull HTF" : bias === -1 ? "bear HTF" : "flat HTF"}`,
              ),
            );
          }
        }
      }
    }

    if (!inKill(c.t) || bias === 0) continue;

    // Unicorn / advanced OB: last opposite candle overlapping a displacement FVG.
    const recentOb = [...obs].reverse().find((o) => o.i < i && o.i >= i - 18 && o.dir === bias);
    const recentFvg = [...fvgs].reverse().find((f) => f.i < i && f.i >= i - 18 && f.dir === bias);
    if (recentOb && recentFvg && overlap(recentOb.top, recentOb.bot, recentFvg.top, recentFvg.bot)) {
      const top = Math.min(recentOb.top, recentFvg.top);
      const bot = Math.max(recentOb.bot, recentFvg.bot);
      const tapped = c.l <= top && c.h >= bot;
      const holds = bias === 1 ? c.c > bot : c.c < top;
      if (tapped && holds) {
        const entry = (top + bot) / 2;
        const stop = bias === 1 ? bot - a * 0.15 : top + a * 0.15;
        const side = bias === 1 ? "long" : "short";
        add(
          pack(
            i,
            c.t,
            side,
            "ob",
            entry,
            stop,
            twoR(side, entry, stop),
            `Unicorn OB∩FVG · ${side} · ${bias === 1 ? "bull" : "bear"} HTF`,
          ),
        );
      }
    } else if (recentOb) {
      const tapped = c.l <= recentOb.top && c.h >= recentOb.bot;
      const holds = recentOb.dir === 1 ? c.c > recentOb.bot : c.c < recentOb.top;
      if (tapped && holds) {
        const entry = (recentOb.top + recentOb.bot) / 2;
        const stop = recentOb.dir === 1 ? recentOb.bot - a * 0.15 : recentOb.top + a * 0.15;
        const side = recentOb.dir === 1 ? "long" : "short";
        add(
          pack(
            i,
            c.t,
            side,
            "ob",
            entry,
            stop,
            twoR(side, entry, stop),
            `Order block · ${side} · TTrades last opposite candle`,
          ),
        );
      }
    }

    if (recentFvg) {
      const ce = (recentFvg.top + recentFvg.bot) / 2;
      const look = cs.slice(Math.max(0, i - 20), i + 1);
      const hi = Math.max(...look.map((x) => x.h));
      const lo = Math.min(...look.map((x) => x.l));
      const mid = (hi + lo) / 2;
      const inPd = bias === 1 ? c.c <= mid : c.c >= mid;
      const tapped = c.l <= recentFvg.top && c.h >= recentFvg.bot;
      if (inPd && tapped) {
        const side = bias === 1 ? "long" : "short";
        const stop = side === "long" ? recentFvg.bot - a * 0.12 : recentFvg.top + a * 0.12;
        add(
          pack(
            i,
            c.t,
            side,
            "fvg",
            ce,
            stop,
            twoR(side, ce, stop),
            `FVG CE · ${side} · ${bias === 1 ? "discount" : "premium"}`,
          ),
        );
      }
    }

    const highs = sw.filter((x) => x.kind === "high" && x.i <= i && x.i >= i - 36).slice(-2);
    const lows = sw.filter((x) => x.kind === "low" && x.i <= i && x.i >= i - 36).slice(-2);
    if (highs.length === 2 && i - highs[1]!.i <= 2) {
      const [p, q] = highs;
      const rp = rsi[p!.i] ?? 50;
      const rq = rsi[q!.i] ?? 50;
      const regular = q!.price > p!.price && rq < rp && rq > 48;
      const hidden = q!.price < p!.price && rq > rp && bias === -1;
      if ((regular && bias !== 1) || hidden) {
        const stop = q!.price + a * 0.2;
        add(
          pack(
            i,
            c.t,
            "short",
            "div",
            c.c,
            stop,
            twoR("short", c.c, stop),
            hidden ? "hidden bearish div · continuation" : "regular bearish div · HH / RSI LH",
          ),
        );
      }
    }
    if (lows.length === 2 && i - lows[1]!.i <= 2) {
      const [p, q] = lows;
      const rp = rsi[p!.i] ?? 50;
      const rq = rsi[q!.i] ?? 50;
      const regular = q!.price < p!.price && rq > rp && rq < 52;
      const hidden = q!.price > p!.price && rq < rp && bias === 1;
      if ((regular && bias !== -1) || hidden) {
        const stop = q!.price - a * 0.2;
        add(
          pack(
            i,
            c.t,
            "long",
            "div",
            c.c,
            stop,
            twoR("long", c.c, stop),
            hidden ? "hidden bullish div · continuation" : "regular bullish div · LL / RSI HL",
          ),
        );
      }
    }
  }
  return signals;
}

/** SMT: correlated pair fails to confirm a swing. Trade the weak one with HTF. */
export function scanSmt(cs: Candle[], other: Candle[], otherSym: string): IctSignal[] {
  if (cs.length < 48 || other.length < 48) return [];
  const out: IctSignal[] = [];
  const byT = new Map(other.map((c) => [c.t, c]));
  for (let i = 24; i < cs.length - 2; i++) {
    const c = cs[i]!;
    if (!inKill(c.t)) continue;
    const bias = htfBias(cs, i);
    if (bias === 0) continue;
    const o = byT.get(c.t);
    if (!o) continue;
    const aLook = cs.slice(i - 16, i);
    const oLook = other.filter((x) => x.t >= cs[i - 16]!.t && x.t < c.t);
    if (aLook.length < 8 || oLook.length < 8) continue;
    const aHigh = Math.max(...aLook.map((x) => x.h));
    const aLow = Math.min(...aLook.map((x) => x.l));
    const oHigh = Math.max(...oLook.map((x) => x.h));
    const oLow = Math.min(...oLook.map((x) => x.l));
    const aHH = c.h > aHigh && c.c < aHigh;
    const aLL = c.l < aLow && c.c > aLow;
    const oHH = o.h > oHigh;
    const oLL = o.l < oLow;
    const a = atr(cs, i);
    if (aHH && !oHH && bias !== 1) {
      const stop = c.h + a * 0.15;
      const sig = pack(i, c.t, "short", "div", c.c, stop, twoR("short", c.c, stop), `SMT bear vs ${otherSym} · failed HH`);
      if (sig) out.push(sig);
    }
    if (aLL && !oLL && bias !== -1) {
      const stop = c.l - a * 0.15;
      const sig = pack(i, c.t, "long", "div", c.c, stop, twoR("long", c.c, stop), `SMT bull vs ${otherSym} · failed LL`);
      if (sig) out.push(sig);
    }
  }
  return out.slice(0, 2);
}

export type ZoneKind = "fvg" | "ob" | "asia" | "nine" | "kill" | "entry" | "stop" | "target";

export interface ChartZone {
  kind: ZoneKind;
  t0: number;
  t1: number;
  top: number;
  bot: number;
  label: string;
  dir: 1 | -1 | 0;
}

function fillAt(cs: Candle[], startI: number, top: number, bot: number, dir: 1 | -1): number {
  for (let k = startI + 1; k < cs.length; k++) {
    if (dir === 1 && cs[k]!.l <= bot) return cs[k]!.t;
    if (dir === -1 && cs[k]!.h >= top) return cs[k]!.t;
  }
  return cs[cs.length - 1]?.t ?? 0;
}

/** Boxes a TV desk would draw: FVG, OB, Asia, 9am hour, kill zones, live signals. */
export function chartLayers(cs: Candle[], signals: IctSignal[] = []): ChartZone[] {
  if (cs.length < 8) return [];
  const lastT = cs[cs.length - 1]!.t;
  const from = Math.max(0, cs.length - 96);
  const view = cs.slice(from);
  const t0 = view[0]!.t;
  const out: ChartZone[] = [];

  for (const c of view) {
    if (!inKill(c.t)) continue;
    const end = Math.min(c.t + 15 * 60_000, lastT);
    const label = isSilver(c.t) ? "SB" : isLondon(c.t) ? "LDN" : isNyAm(c.t) ? "NY" : "PM";
    out.push({ kind: "kill", t0: c.t, t1: end, top: 0, bot: 0, label, dir: 0 });
  }

  const asia = buildAsia(cs);
  for (const rec of asia.values()) {
    const dayBars = view.filter((c) => {
      const p = nyParts(c.t);
      let day = p.day;
      if (p.h >= 20) {
        const shifted = c.t - NY_OFFSET_MS + 24 * 3600_000;
        const d = new Date(shifted);
        day = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      }
      return day === rec.day && !isAsia(c.t);
    });
    if (!dayBars.length) continue;
    out.push({
      kind: "asia",
      t0: dayBars[0]!.t,
      t1: dayBars[dayBars.length - 1]!.t,
      top: rec.asiaH,
      bot: rec.asiaL,
      label: "Asia",
      dir: 0,
    });
  }

  const days = new Set(view.map((c) => nyParts(c.t).day));
  for (const day of days) {
    const nine = hourRange(cs, day, 9, 10);
    if (!nine) continue;
    const bars = view.filter((c) => nyParts(c.t).day === day && nyHour(c.t) >= 9 && nyHour(c.t) < 10);
    if (!bars.length) continue;
    out.push({
      kind: "nine",
      t0: bars[0]!.t,
      t1: bars[bars.length - 1]!.t + 15 * 60_000,
      top: nine.h,
      bot: nine.l,
      label: "9am",
      dir: 0,
    });
  }

  const fvgs = detectFvgs(cs).filter((f) => f.i >= from).slice(-10);
  for (const f of fvgs) {
    const start = cs[f.i]!.t;
    const filled = fillAt(cs, f.i, f.top, f.bot, f.dir);
    out.push({
      kind: "fvg",
      t0: start,
      t1: Math.max(start, filled),
      top: f.top,
      bot: f.bot,
      label: f.dir === 1 ? "BU FVG" : "BE FVG",
      dir: f.dir,
    });
  }

  const obs = detectObs(cs).filter((o) => o.i >= from).slice(-8);
  for (const o of obs) {
    const start = cs[o.i]!.t;
    const filled = fillAt(cs, o.i, o.top, o.bot, o.dir);
    out.push({
      kind: "ob",
      t0: start,
      t1: Math.max(start, filled),
      top: o.top,
      bot: o.bot,
      label: o.dir === 1 ? "Bull OB" : "Bear OB",
      dir: o.dir,
    });
  }

  for (const s of signals) {
    if (s.t < t0) continue;
    out.push({
      kind: "entry",
      t0: s.t,
      t1: lastT,
      top: s.entry,
      bot: s.entry,
      label: `${s.side} ${s.setup}`,
      dir: s.side === "long" ? 1 : -1,
    });
    out.push({
      kind: "stop",
      t0: s.t,
      t1: lastT,
      top: s.stop,
      bot: s.stop,
      label: "SL",
      dir: s.side === "long" ? -1 : 1,
    });
    out.push({
      kind: "target",
      t0: s.t,
      t1: lastT,
      top: s.target,
      bot: s.target,
      label: "TP",
      dir: s.side === "long" ? 1 : -1,
    });
  }
  return out;
}

export interface IctSimTrade extends ClosedTrade {
  stop: number;
  target: number;
}

export function simulateIct(
  cs: Candle[],
  signals: IctSignal[],
  riskUsd = 10,
  symbol = "SOL",
  name = "Solana",
): IctSimTrade[] {
  const trades: IctSimTrade[] = [];
  for (const s of signals) {
    let exit = s.entry;
    let reason: ClosedTrade["reason"] = "time";
    let closedAt = cs[cs.length - 1]?.t ?? s.t;
    for (let i = s.i + 1; i < cs.length; i++) {
      const c = cs[i]!;
      if (s.side === "long") {
        if (c.l <= s.stop) {
          exit = s.stop;
          reason = "stop";
          closedAt = c.t;
          break;
        }
        if (c.h >= s.target) {
          exit = s.target;
          reason = "target";
          closedAt = c.t;
          break;
        }
      } else {
        if (c.h >= s.stop) {
          exit = s.stop;
          reason = "stop";
          closedAt = c.t;
          break;
        }
        if (c.l <= s.target) {
          exit = s.target;
          reason = "target";
          closedAt = c.t;
          break;
        }
      }
      if (i > s.i + 32) {
        exit = c.c;
        reason = "time";
        closedAt = c.t;
        break;
      }
    }
    const dir = s.side === "long" ? 1 : -1;
    const r = (exit - s.entry) * dir / Math.abs(s.entry - s.stop);
    const pnlUsd = r * riskUsd;
    trades.push({
      id: `ict-${symbol}-${s.setup}-${s.i}`,
      symbol,
      name,
      setup: s.setup,
      side: s.side,
      openedAt: s.t,
      closedAt,
      entryUsd: s.entry,
      exitUsd: exit,
      sizeSol: riskUsd / Math.abs(s.entry - s.stop),
      pnlSol: 0,
      pnlUsd,
      rMultiple: r,
      reason,
      score: 0.7,
      note: s.note,
      origin: "ict",
      stop: s.stop,
      target: s.target,
    });
  }
  return trades;
}

export function oddsFromTrades(trades: ClosedTrade[]): SetupOdds[] {
  const kinds: SetupKind[] = ["silver", "amd", "sweep", "fvg", "ob", "div", "curve"];
  const labels: Record<SetupKind, string> = {
    silver: "Silver Bullet 10–11 NY",
    amd: "Power of 3 (AMD)",
    sweep: "Sweep + CISD",
    fvg: "Fair value gap CE",
    ob: "Order block / Unicorn",
    div: "RSI / hidden / SMT",
    curve: "Pump.fun early curve",
    published: "Published outlier",
  };
  const notes: Record<SetupKind, string> = {
    silver: "TTrades AM Silver Bullet. Sweep the 9am hour, CISD, FVG.",
    amd: "Asia range, London wick, NY distribution.",
    sweep: "Stop raid then CISD. Sweep alone is not a trade.",
    fvg: "Displacement FVG, entry at consequent encroachment in PD.",
    ob: "Last opposite candle. Unicorn = OB overlapping FVG.",
    div: "Regular and hidden RSI divergence plus BTC/ETH SMT.",
    curve: "Bonding-curve filter from the five-agent desk.",
    published: "Reconstructed from the public @zostaff writeup.",
  };
  return kinds.map((setup) => {
    const rows = trades.filter((t) => t.setup === setup);
    const wins = rows.filter((t) => t.pnlUsd > 0).length;
    const avgR =
      rows.length === 0
        ? 0
        : rows.reduce((s, t) => s + t.rMultiple, 0) / rows.length;
    const expectancyR =
      rows.length === 0
        ? 0
        : rows.reduce((s, t) => s + t.rMultiple, 0) / rows.length;
    return {
      setup,
      label: labels[setup],
      trades: rows.length,
      wins,
      winRate: rows.length ? wins / rows.length : 0,
      avgR,
      expectancyR,
      notes: notes[setup],
    };
  });
}

export function parseKlines(rows: number[][]): Candle[] {
  return rows.map(([t, o, h, l, c, v]) => ({
    t,
    o,
    h,
    l,
    c,
    v,
  }));
}
