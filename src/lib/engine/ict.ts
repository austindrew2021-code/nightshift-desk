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
 * TTrades mechanical checklist:
 *  Daily/HTF bias first.
 *  AMD: Asia accumulates, London manipulates (daily wick), NY distributes.
 *  Silver Bullet 10–11 NY: sweep the 9:00 hour, CISD back in, FVG, target the other side.
 *  CISD = close through the candles that made the raid (TTrades). Sweep alone is not a trade.
 */
export function scanIct(cs: Candle[]): IctSignal[] {
  if (cs.length < 48) return [];
  const asia = buildAsia(cs);
  const signals: IctSignal[] = [];
  const usedDays = new Set<string>();
  const londonRaid = new Map<string, "high" | "low">();

  for (let i = 24; i < cs.length - 2; i++) {
    const c = cs[i]!;
    const day = nyParts(c.t).day;
    if (usedDays.has(day)) continue;
    const bias = htfBias(cs, i);

    if (isLondon(c.t)) {
      const range = asia.get(day);
      if (range?.asiaReady) {
        if (c.h > range.asiaH && c.c < range.asiaH) londonRaid.set(day, "high");
        if (c.l < range.asiaL && c.c > range.asiaL) londonRaid.set(day, "low");
      }
    }

    if (isSilver(c.t)) {
      const nine = hourRange(cs, day, 9, 10);
      if (!nine) continue;
      const sweptLow = c.l < nine.l && c.c > nine.l;
      const sweptHigh = c.h > nine.h && c.c < nine.h;
      const side: "long" | "short" | null = sweptLow ? "long" : sweptHigh ? "short" : null;
      if (!side) continue;
      if (bias === 1 && side === "short") continue;
      if (bias === -1 && side === "long") continue;
      const conf = cisd(cs, i, side);
      if (!conf.ok || !conf.fvg) continue;
      const sweepPx = side === "long" ? Math.min(c.l, nine.l) : Math.max(c.h, nine.h);
      const entry = (conf.fvg.bot + conf.fvg.top) / 2;
      const stopPad = (nine.h - nine.l) * 0.08 || entry * 0.002;
      const stop = side === "long" ? sweepPx - stopPad : sweepPx + stopPad;
      const risk = Math.abs(entry - stop);
      if (risk <= 0 || risk / entry > 0.025) continue;
      const erl = side === "long" ? nine.h : nine.l;
      const target = side === "long" ? Math.max(erl, entry + risk * 2) : Math.min(erl, entry - risk * 2);
      signals.push({
        i: conf.i,
        t: cs[conf.i]!.t,
        side,
        setup: "silver",
        entry,
        stop,
        target,
        note: `SB 10–11 NY · swept 9am ${side === "long" ? "low" : "high"} · CISD · FVG · tgt other side of 9am`,
      });
      usedDays.add(day);
      continue;
    }

    if (isLondon(c.t) || isNyAm(c.t)) {
      const range = asia.get(day);
      if (!range?.asiaReady) continue;
      const raid = londonRaid.get(day);
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
      } else if (isNyAm(c.t) && raid) {
        if (raid === "low" && bias !== -1 && c.c > range.asiaL) {
          side = "long";
          sweepPx = range.asiaL;
          note = "AMD · NY distribution after London SSL";
        } else if (raid === "high" && bias !== 1 && c.c < range.asiaH) {
          side = "short";
          sweepPx = range.asiaH;
          note = "AMD · NY distribution after London BSL";
        }
      }
      if (!side) continue;
      const conf = cisd(cs, i, side);
      if (!conf.ok) continue;
      if (isNyAm(c.t) && !conf.fvg) continue;
      const entry = conf.fvg ? (conf.fvg.bot + conf.fvg.top) / 2 : cs[conf.i]!.c;
      const stopPad = (range.asiaH - range.asiaL) * 0.06 || entry * 0.0025;
      const stop = side === "long" ? sweepPx - stopPad : sweepPx + stopPad;
      const risk = Math.abs(entry - stop);
      if (risk <= 0 || risk / entry > 0.03) continue;
      const erl = side === "long" ? range.asiaH : range.asiaL;
      const twoR = side === "long" ? entry + risk * 2 : entry - risk * 2;
      const erlR = Math.abs(erl - entry) / risk;
      const target = erlR >= 1.2 ? erl : twoR;
      signals.push({
        i: conf.i,
        t: cs[conf.i]!.t,
        side,
        setup: isLondon(c.t) ? "amd" : "sweep",
        entry,
        stop,
        target,
        note: `${note} · CISD${conf.fvg ? " · FVG" : ""} · ${bias === 1 ? "bull HTF" : bias === -1 ? "bear HTF" : "no HTF"}`,
      });
      usedDays.add(day);
    }
  }
  return signals;
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
      id: `ict-${symbol}-${s.t}`,
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
  const kinds: SetupKind[] = ["silver", "amd", "sweep", "fvg", "curve"];
  const labels: Record<SetupKind, string> = {
    silver: "Silver Bullet 10–11 NY",
    amd: "Power of 3 (AMD)",
    sweep: "Sweep + MSS",
    fvg: "Fair value gap",
    curve: "Pump.fun early curve",
    published: "Published outlier",
  };
  const notes: Record<SetupKind, string> = {
    silver: "TTrades AM Silver Bullet window. FVG after the raid.",
    amd: "Asia liquidity, London manipulation, NY distribution.",
    sweep: "A+ checklist: stop raid, displacement, discount PD array.",
    fvg: "Three-candle imbalance, entry on the fill.",
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
