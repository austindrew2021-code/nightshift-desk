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
    // Asia 20:00–02:00 NY belongs to the *next* NY session day.
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
 * Mechanical TTrades-style A+ checklist on 15m SOL:
 *  1. Asia range as liquidity
 *  2. London or NY AM stop-raid (sweep)
 *  3. Displacement / MSS back inside
 *  4. Retrace into FVG or order block in discount/premium
 *  5. Silver Bullet (10–11 NY) preferred; AMD continuation also tagged
 */
export function scanIct(cs: Candle[]): IctSignal[] {
  if (cs.length < 40) return [];
  const asia = buildAsia(cs);
  const fvgs = detectFvgs(cs);
  const signals: IctSignal[] = [];
  const usedDays = new Set<string>();

  for (let i = 8; i < cs.length - 1; i++) {
    const c = cs[i]!;
    const day = nyParts(c.t).day;
    if (usedDays.has(day)) continue;
    if (!(isLondon(c.t) || isNyAm(c.t) || isSilver(c.t))) continue;
    const range = asia.get(day);
    if (!range || !range.asiaReady) continue;

    const lookback = cs.slice(Math.max(0, i - 16), i + 1);
    const hi = Math.max(...lookback.map((x) => x.h));
    const lo = Math.min(...lookback.map((x) => x.l));

    const sweptHigh = c.h > range.asiaH && c.c < range.asiaH;
    const sweptLow = c.l < range.asiaL && c.c > range.asiaL;
    const sweptEqHigh = c.h > hi - (hi - lo) * 0.02 && c.c < (lookback[lookback.length - 2]?.c ?? c.c);
    const sweptEqLow = c.l < lo + (hi - lo) * 0.02 && c.c > (lookback[lookback.length - 2]?.c ?? c.c);

    let side: "long" | "short" | null = null;
    let sweepPx = 0;
    let note = "";

    if (sweptLow || (c.l < range.asiaL && c.c > c.o && (sweptEqLow || isSilver(c.t)))) {
      side = "long";
      sweepPx = Math.min(c.l, range.asiaL);
      note = sweptLow ? "swept Asia low" : "raid on session low";
    } else if (sweptHigh || (c.h > range.asiaH && c.c < c.o && (sweptEqHigh || isSilver(c.t)))) {
      side = "short";
      sweepPx = Math.max(c.h, range.asiaH);
      note = sweptHigh ? "swept Asia high" : "raid on session high";
    }
    if (!side) continue;

    // Displacement: next 1–4 candles close in the trade direction past the sweep candle body.
    let mss = false;
    let fvg: FVG | undefined;
    for (let k = i + 1; k <= Math.min(cs.length - 1, i + 6); k++) {
      const n = cs[k]!;
      if (side === "long" && n.c > c.h) mss = true;
      if (side === "short" && n.c < c.l) mss = true;
      const found = fvgs.find((f) => f.i === k && f.dir === (side === "long" ? 1 : -1));
      if (found) fvg = found;
    }
    if (!mss) continue;

    const setup: SetupKind = isSilver(c.t) ? "silver" : isLondon(c.t) ? "amd" : "sweep";
    const entry = fvg
      ? side === "long"
        ? (fvg.bot + fvg.top) / 2
        : (fvg.bot + fvg.top) / 2
      : c.c;
    const stopPad = (hi - lo) * 0.08 || entry * 0.004;
    const stop = side === "long" ? sweepPx - stopPad : sweepPx + stopPad;
    const risk = Math.abs(entry - stop);
    if (risk <= 0 || risk / entry > 0.03) continue; // skip oversized stops
    const target = side === "long" ? entry + risk * 2 : entry - risk * 2;

    const pd = fvg ? "FVG" : "displacement close";
    signals.push({
      i,
      t: c.t,
      side,
      setup,
      entry,
      stop,
      target,
      note: `${note}; MSS; ${pd}; ${setup === "silver" ? "Silver Bullet" : setup === "amd" ? "Power of 3" : "A+ sweep"}`,
    });
    usedDays.add(day);
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
      id: `ict-${s.t}`,
      symbol: "SOL",
      name: "Solana",
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
