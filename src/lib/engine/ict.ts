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
export function isJudas(t: number): boolean {
  return inWindow(t, 7, 10);
}
export function isSilverPm(t: number): boolean {
  return inWindow(t, 14, 15);
}
export function isNyPm(t: number): boolean {
  return inWindow(t, 13.5, 16);
}
export function inKill(t: number): boolean {
  return isLondon(t) || isNyAm(t) || isSilver(t) || isSilverPm(t) || isNyPm(t);
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

/** OB closed through, then used the other way. */
export function detectBreakers(cs: Candle[]): OrderBlock[] {
  const obs = detectObs(cs);
  const out: OrderBlock[] = [];
  for (const o of obs) {
    for (let k = o.i + 1; k < Math.min(cs.length, o.i + 28); k++) {
      const n = cs[k]!;
      if (o.dir === -1 && n.c > o.top) {
        out.push({ i: o.i, t: o.t, dir: 1, top: o.top, bot: o.bot });
        break;
      }
      if (o.dir === 1 && n.c < o.bot) {
        out.push({ i: o.i, t: o.t, dir: -1, top: o.top, bot: o.bot });
        break;
      }
    }
  }
  return out;
}

/** FVG fully closed through becomes an inversion. */
export function detectIfvg(cs: Candle[]): FVG[] {
  const fvgs = detectFvgs(cs);
  const out: FVG[] = [];
  for (const f of fvgs) {
    for (let k = f.i + 1; k < Math.min(cs.length, f.i + 24); k++) {
      const n = cs[k]!;
      if (f.dir === 1 && n.c < f.bot) {
        out.push({ i: f.i, t: f.t, dir: -1, top: f.top, bot: f.bot });
        break;
      }
      if (f.dir === -1 && n.c > f.top) {
        out.push({ i: f.i, t: f.t, dir: 1, top: f.top, bot: f.bot });
        break;
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

/** ~6h slope so 5m bias isn't a 2-hour flip. */
export function htfBias(cs: Candle[], i: number): 1 | -1 | 0 {
  const dt = i > 0 ? Math.max(60_000, cs[i]!.t - cs[i - 1]!.t) : 15 * 60_000;
  const look = Math.min(i, Math.max(24, Math.round((6 * 3600_000) / dt)));
  if (look < 12) return 0;
  const a = cs[i - look]!.c;
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
    for (let k = sweepI + 1; k <= Math.min(cs.length - 1, sweepI + 8); k++) {
      const n = cs[k]!;
      const body = Math.abs(n.c - n.o);
      const range = n.h - n.l || 1;
      if (n.c > seriesHigh && n.c > n.o && body / range >= 0.4 && body >= atr(cs, k) * 0.35) {
        const fvg = fvgs.find((f) => f.i === k && f.dir === 1);
        return { ok: true, i: k, fvg };
      }
    }
  } else {
    let seriesLow = cs[sweepI]!.l;
    for (let k = from; k <= sweepI; k++) {
      if (cs[k]!.c >= cs[k]!.o) seriesLow = Math.min(seriesLow, cs[k]!.l);
    }
    for (let k = sweepI + 1; k <= Math.min(cs.length - 1, sweepI + 8); k++) {
      const n = cs[k]!;
      const body = Math.abs(n.c - n.o);
      const range = n.h - n.l || 1;
      if (n.c < seriesLow && n.c < n.o && body / range >= 0.4 && body >= atr(cs, k) * 0.35) {
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
  maxRisk = 0.055,
): IctSignal | null {
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || risk <= 0) return null;
  if (risk / entry > maxRisk) return null;
  if (side === "long" && target <= entry) return null;
  if (side === "short" && target >= entry) return null;
  return { i, t, side, setup, entry, stop, target, note };
}

function twoR(side: "long" | "short", entry: number, stop: number, erl?: number, mult = 2): number {
  const risk = Math.abs(entry - stop);
  const raw = side === "long" ? entry + risk * mult : entry - risk * mult;
  if (erl == null || !Number.isFinite(erl)) return raw;
  const erlR = Math.abs(erl - entry) / risk;
  if (erlR < 1.2) return raw;
  return side === "long" ? Math.max(erl, raw) : Math.min(erl, raw);
}

interface RaidMem {
  side: "long" | "short";
  sweepI: number;
  sweepPx: number;
  src: string;
}

function rememberRaid(map: Map<string, RaidMem>, day: string, raid: RaidMem) {
  const prev = map.get(day);
  if (!prev) {
    map.set(day, raid);
    return;
  }
  if (raid.side !== prev.side) {
    // Fresh opposite raid replaces — last liquidity taken is the one we fade.
    map.set(day, raid);
    return;
  }
  if (raid.side === "short" && raid.sweepPx >= prev.sweepPx) map.set(day, raid);
  if (raid.side === "long" && raid.sweepPx <= prev.sweepPx) map.set(day, raid);
}

function hourRangeAt(
  cs: Candle[],
  day: string,
  startH: number,
  endH: number,
  upTo: number,
): { h: number; l: number } | null {
  let h = -Infinity;
  let l = Infinity;
  const last = Math.min(upTo, cs.length - 1);
  for (let i = 0; i <= last; i++) {
    const c = cs[i]!;
    if (nyParts(c.t).day !== day) continue;
    const hr = nyHour(c.t);
    if (hr < startH || hr >= endH) continue;
    h = Math.max(h, c.h);
    l = Math.min(l, c.l);
  }
  if (!Number.isFinite(h) || !Number.isFinite(l) || h <= l) return null;
  return { h, l };
}

function hourExtremeIndex(
  cs: Candle[],
  day: string,
  startH: number,
  endH: number,
  upTo: number,
  side: "long" | "short",
): number {
  let best = -1;
  let px = side === "long" ? Infinity : -Infinity;
  const last = Math.min(upTo, cs.length - 1);
  for (let i = 0; i <= last; i++) {
    const c = cs[i]!;
    if (nyParts(c.t).day !== day) continue;
    const hr = nyHour(c.t);
    if (hr < startH || hr >= endH) continue;
    if (side === "short" && c.h >= px) {
      px = c.h;
      best = i;
    }
    if (side === "long" && c.l <= px) {
      px = c.l;
      best = i;
    }
  }
  return best;
}

/** 24h open→close. Flatter than the 6h 0.35% slope, closer to a daily bias. */
function dailyBias(cs: Candle[], i: number): 1 | -1 | 0 {
  const dt = i > 0 ? Math.max(60_000, cs[i]!.t - cs[i - 1]!.t) : 15 * 60_000;
  const look = Math.min(i, Math.max(16, Math.round((24 * 3600_000) / dt)));
  if (look < 16) return htfBias(cs, i);
  const a = cs[i - look]!.o;
  const b = cs[i]!.c;
  if (a <= 0) return 0;
  const ch = (b - a) / a;
  if (ch > 0.005) return 1;
  if (ch < -0.005) return -1;
  return 0;
}

function dolPrice(sw: Swing[], i: number, side: "long" | "short", entry: number): number | undefined {
  const kind = side === "long" ? "high" : "low";
  const rows = sw.filter((x) => x.kind === kind && x.i <= i && x.i >= i - 72);
  if (!rows.length) return undefined;
  if (side === "long") {
    const above = rows.filter((x) => x.price > entry * 1.001);
    return above.length ? Math.max(...above.map((x) => x.price)) : Math.max(...rows.map((x) => x.price));
  }
  const below = rows.filter((x) => x.price < entry * 0.999);
  return below.length ? Math.min(...below.map((x) => x.price)) : Math.min(...rows.map((x) => x.price));
}

/**
 * TTrades A+: liquidity raid → CISD/MSS with displacement → FVG or OB in
 * premium (short) / discount (long) of that displacement → DOL ≥ 1.7R.
 * Sweep alone is not a trade. Unicorn (OB∩FVG) grades A+.
 */
function aPlus(
  cs: Candle[],
  fvgs: FVG[],
  obs: OrderBlock[],
  sw: Swing[],
  raid: RaidMem,
  setup: SetupKind,
  note: string,
  targetMult: number,
  maxRisk = 0.055,
): IctSignal | null {
  const conf = cisd(cs, raid.sweepI, raid.side);
  if (!conf.ok) return null;
  const want: 1 | -1 = raid.side === "long" ? 1 : -1;
  const fvg =
    conf.fvg ??
    [...fvgs]
      .reverse()
      .find((f) => f.dir === want && f.i <= conf.i && f.i >= Math.max(0, raid.sweepI - 2));
  const ob = [...obs]
    .reverse()
    .find((o) => o.dir === want && o.i <= conf.i && o.i >= Math.max(0, raid.sweepI - 8));
  const uni = Boolean(fvg && ob && overlap(ob.top, ob.bot, fvg.top, fvg.bot));
  if (!fvg && !ob) return null;
  const zone = uni && fvg && ob
    ? { top: Math.min(ob.top, fvg.top), bot: Math.max(ob.bot, fvg.bot), tag: "Unicorn OB∩FVG" }
    : fvg
      ? { top: fvg.top, bot: fvg.bot, tag: "FVG CE" }
      : { top: ob!.top, bot: ob!.bot, tag: "OB" };
  let dH = -Infinity;
  let dL = Infinity;
  for (let k = raid.sweepI; k <= conf.i; k++) {
    dH = Math.max(dH, cs[k]!.h);
    dL = Math.min(dL, cs[k]!.l);
  }
  dH = Math.max(dH, raid.sweepPx);
  dL = Math.min(dL, raid.sweepPx);
  if (!Number.isFinite(dH) || dH <= dL) return null;
  const eq = (dH + dL) / 2;
  const entry = (zone.top + zone.bot) / 2;
  if (raid.side === "short" && zone.top < eq) return null;
  if (raid.side === "long" && zone.bot > eq) return null;
  const a = atr(cs, conf.i);
  const stopPad = a * 0.12;
  const stop = raid.side === "long" ? raid.sweepPx - stopPad : raid.sweepPx + stopPad;
  const dol = dolPrice(sw, conf.i, raid.side, entry);
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  if (dol != null && Math.abs(dol - entry) / risk < 1.7) return null;
  const tgt = twoR(raid.side, entry, stop, dol, targetMult);
  if (Math.abs(tgt - entry) / risk < 1.7) return null;
  const grade = uni ? "A+" : "A";
  return pack(
    conf.i,
    cs[conf.i]!.t,
    raid.side,
    setup,
    entry,
    stop,
    tgt,
    `${note} · ${raid.src} · CISD · ${zone.tag} · ${grade} · ${targetMult.toFixed(1)}R`,
    maxRisk,
  );
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
 * TTrades A+ on 15m/5m:
 *  daily bias, AMD London wick of Asia, Judas 7–10 NY (incl. 9am true open),
 *  Silver Bullet 10–11 NY on the 9am hour, PM Silver Bullet 2–3 NY,
 *  CISD, Unicorn OB∩FVG, FVG CE in premium/discount of the displacement,
 *  DOL ≥ 1.7R. Sweep alone is not a trade. RSI-div is not a trade.
 *  Per NY day: session models kept; at most one Unicorn continuation.
 */
export function scanIct(cs: Candle[], opts?: { skipSwing?: boolean; includeSwing?: boolean }): IctSignal[] {
  if (cs.length < 48) return [];
  const asia = buildAsia(cs);
  const fvgs = detectFvgs(cs);
  const obs = detectObs(cs);
  const sw = swings(cs, 3, 2);
  const signals: IctSignal[] = [];
  const asiaRaid = new Map<string, RaidMem>();
  const ovnRaid = new Map<string, RaidMem>();
  const amRaid = new Map<string, RaidMem>();

  const add = (sig: IctSignal | null) => {
    if (!sig) return;
    if (signals.some((x) => Math.abs(x.i - sig.i) < 4 && x.side === sig.side)) return;
    signals.push(sig);
  };

  for (let i = 24; i < cs.length; i++) {
    const c = cs[i]!;
    const day = nyParts(c.t).day;
    const range = asia.get(day);
    const london = hourRangeAt(cs, day, 2, 5, i);
    const ovnH = Math.max(range?.asiaH ?? -Infinity, london?.h ?? -Infinity);
    const ovnL = Math.min(range?.asiaL ?? Infinity, london?.l ?? Infinity);

    if (range?.asiaReady) {
      if (c.h > range.asiaH) {
        rememberRaid(asiaRaid, day, { side: "short", sweepI: i, sweepPx: c.h, src: "Asia high" });
      }
      if (c.l < range.asiaL) {
        rememberRaid(asiaRaid, day, { side: "long", sweepI: i, sweepPx: c.l, src: "Asia low" });
      }
    }
    if (Number.isFinite(ovnH) && Number.isFinite(ovnL) && ovnH > ovnL) {
      if (c.h > ovnH) {
        rememberRaid(ovnRaid, day, { side: "short", sweepI: i, sweepPx: c.h, src: "overnight high" });
      }
      if (c.l < ovnL) {
        rememberRaid(ovnRaid, day, { side: "long", sweepI: i, sweepPx: c.l, src: "overnight low" });
      }
    }

    const am = hourRangeAt(cs, day, 7, 13.5, i);
    if (am && nyHour(c.t) >= 13.5) {
      if (c.h > am.h) {
        rememberRaid(amRaid, day, { side: "short", sweepI: i, sweepPx: c.h, src: "AM session high" });
      }
      if (c.l < am.l) {
        rememberRaid(amRaid, day, { side: "long", sweepI: i, sweepPx: c.l, src: "AM session low" });
      }
    }

    if (isLondon(c.t) && asiaRaid.has(day)) {
      add(
        aPlus(
          cs,
          fvgs,
          obs,
          sw,
          asiaRaid.get(day)!,
          "amd",
          "AMD · London raid of Asia",
          3,
        ),
      );
    }

    if (isJudas(c.t) && ovnRaid.has(day)) {
      add(
        aPlus(
          cs,
          fvgs,
          obs,
          sw,
          ovnRaid.get(day)!,
          "judas",
          "Judas 7–10 NY · fake open",
          2,
        ),
      );
    }

    if (isSilver(c.t)) {
      const nineDone = hourRangeAt(cs, day, 9, 10, i);
      if (nineDone) {
        const sweptLow = c.l < nineDone.l && c.c > nineDone.l;
        const sweptHigh = c.h > nineDone.h && c.c < nineDone.h;
        if (sweptHigh) {
          add(
            aPlus(
              cs,
              fvgs,
              obs,
              sw,
              { side: "short", sweepI: i, sweepPx: c.h, src: "9am high" },
              "silver",
              "SB 10–11 NY · swept 9am high",
              2,
            ),
          );
        } else if (sweptLow) {
          add(
            aPlus(
              cs,
              fvgs,
              obs,
              sw,
              { side: "long", sweepI: i, sweepPx: c.l, src: "9am low" },
              "silver",
              "SB 10–11 NY · swept 9am low",
              2,
            ),
          );
        } else {
          const asiaR = asia.get(day);
          if (asiaR?.asiaReady && nineDone.h > asiaR.asiaH && c.c < nineDone.h && c.c < c.o) {
            const extI = hourExtremeIndex(cs, day, 9, 10, i, "short");
            add(
              aPlus(
                cs,
                fvgs,
                obs,
                sw,
                {
                  side: "short",
                  sweepI: extI >= 0 ? extI : i,
                  sweepPx: nineDone.h,
                  src: "9am Asia-high fail",
                },
                "silver",
                "SB 10–11 NY · 9am fail-through",
                2,
              ),
            );
          } else if (asiaR?.asiaReady && nineDone.l < asiaR.asiaL && c.c > nineDone.l && c.c > c.o) {
            const extI = hourExtremeIndex(cs, day, 9, 10, i, "long");
            add(
              aPlus(
                cs,
                fvgs,
                obs,
                sw,
                {
                  side: "long",
                  sweepI: extI >= 0 ? extI : i,
                  sweepPx: nineDone.l,
                  src: "9am Asia-low fail",
                },
                "silver",
                "SB 10–11 NY · 9am fail-through",
                2,
              ),
            );
          }
        }
      }
    }

    if (isSilverPm(c.t) && amRaid.has(day)) {
      add(
        aPlus(
          cs,
          fvgs,
          obs,
          sw,
          amRaid.get(day)!,
          "silver",
          "SB 2–3 NY · AM session raid",
          2,
        ),
      );
    }

    if (isNyPm(c.t) && amRaid.has(day)) {
      add(
        aPlus(
          cs,
          fvgs,
          obs,
          sw,
          amRaid.get(day)!,
          "scalp",
          "PM scalp 1:30–4 NY",
          2,
        ),
      );
    }
  }

  if (opts?.includeSwing) for (const s of scanSwing(cs)) add(s);
  return pickDay(signals);
}

function lastFractal(sw: Swing[], i: number, kind: "high" | "low"): Swing | null {
  const rows = sw.filter((x) => x.kind === kind && x.i < i - 1 && x.i >= i - 48);
  return rows.at(-1) ?? null;
}

/** TTrades: take liquidity at the last swing high (BSL) or swing low (SSL), then reverse. */
function recentSweep(cs: Candle[], sw: Swing[], i: number, side: "long" | "short", look = 12): Swing | null {
  const kind = side === "long" ? "low" : "high";
  const fx = lastFractal(sw, i, kind);
  if (!fx) return null;
  const from = Math.max(fx.i, i - look);
  for (let k = i; k >= from; k--) {
    const c = cs[k]!;
    if (side === "long" && c.l < fx.price && c.c > fx.price) return fx;
    if (side === "short" && c.h > fx.price && c.c < fx.price) return fx;
  }
  return null;
}

function equalPool(sw: Swing[], i: number, a: number): { kind: "high" | "low"; px: number } | null {
  const highs = sw.filter((x) => x.kind === "high" && x.i < i && x.i >= i - 48).slice(-5);
  const lows = sw.filter((x) => x.kind === "low" && x.i < i && x.i >= i - 48).slice(-5);
  const tol = Math.max(a * 0.15, 1e-9);
  for (let x = highs.length - 1; x >= 1; x--) {
    if (Math.abs(highs[x]!.price - highs[x - 1]!.price) <= tol) {
      return { kind: "high", px: Math.max(highs[x]!.price, highs[x - 1]!.price) };
    }
  }
  for (let x = lows.length - 1; x >= 1; x--) {
    if (Math.abs(lows[x]!.price - lows[x - 1]!.price) <= tol) {
      return { kind: "low", px: Math.min(lows[x]!.price, lows[x - 1]!.price) };
    }
  }
  return null;
}

function sessionHiLo(cs: Candle[], day: string, startH: number, endH: number): { h: number; l: number } | null {
  return hourRange(cs, day, startH, endH);
}

function impulseRange(cs: Candle[], i: number, bias: 1 | -1): { high: number; low: number } | null {
  const from = Math.max(0, i - 16);
  let hi = -Infinity;
  let lo = Infinity;
  let start = from;
  for (let k = i; k >= from; k--) {
    const c = cs[k]!;
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
    const body = Math.abs(c.c - c.o);
    const range = c.h - c.l || 1;
    if (body / range >= 0.6 && ((bias === 1 && c.c > c.o) || (bias === -1 && c.c < c.o))) {
      start = k;
      break;
    }
  }
  if (start === from && i - from < 6) return null;
  hi = -Infinity;
  lo = Infinity;
  for (let k = start; k <= i; k++) {
    hi = Math.max(hi, cs[k]!.h);
    lo = Math.min(lo, cs[k]!.l);
  }
  if (!Number.isFinite(hi) || hi <= lo) return null;
  return { high: hi, low: lo };
}

function foldHour(cs: Candle[]): { bar: Candle; i: number }[] {
  const out: { bar: Candle; i: number }[] = [];
  for (let i = 0; i < cs.length; i += 4) {
    const sl = cs.slice(i, Math.min(cs.length, i + 4));
    if (!sl.length) continue;
    out.push({
      bar: {
        t: sl[0]!.t,
        o: sl[0]!.o,
        h: Math.max(...sl.map((x) => x.h)),
        l: Math.min(...sl.map((x) => x.l)),
        c: sl[sl.length - 1]!.c,
        v: sl.reduce((s, x) => s + x.v, 0),
      },
      i: i + sl.length - 1,
    });
  }
  return out;
}

function scanSwing(cs: Candle[]): IctSignal[] {
  const h1 = foldHour(cs);
  if (h1.length < 24) return [];
  const bars = h1.map((x) => x.bar);
  const obs = detectObs(bars);
  const fvgs = detectFvgs(bars);
  const out: IctSignal[] = [];
  for (let k = 16; k < h1.length; k++) {
    const b = bars[k]!;
    const i15 = h1[k]!.i;
    const bias = dailyBias(bars, k);
    if (bias === 0) continue;
    if (!inKill(b.t)) continue;
    const a = atr(bars, k);
    const sw1 = swings(bars, 2, 2);
    const side0: "long" | "short" = bias === 1 ? "long" : "short";
    const liq = recentSweep(bars, sw1, k, side0, 8);
    if (!liq) continue;
    const ob = [...obs].reverse().find((o) => o.i < k && o.i >= k - 12 && o.dir === bias);
    const fvg = [...fvgs].reverse().find((f) => f.i < k && f.i >= k - 12 && f.dir === bias);
    const zone = ob && fvg && overlap(ob.top, ob.bot, fvg.top, fvg.bot)
      ? { top: Math.min(ob.top, fvg.top), bot: Math.max(ob.bot, fvg.bot), tag: "Unicorn 1H" }
      : ob
        ? { top: ob.top, bot: ob.bot, tag: "1H OB" }
        : fvg
          ? { top: fvg.top, bot: fvg.bot, tag: "1H FVG" }
          : null;
    if (!zone) continue;
    const tapped = b.l <= zone.top && b.h >= zone.bot;
    const holds = bias === 1 ? b.c > zone.bot : b.c < zone.top;
    if (!tapped || !holds) continue;
    const side = bias === 1 ? "long" : "short";
    const entry = (zone.top + zone.bot) / 2;
    const stop = bias === 1 ? zone.bot - a * 0.2 : zone.top + a * 0.2;
    const sig = pack(
      i15,
      cs[i15]!.t,
      side,
      "swing",
      entry,
      stop,
      twoR(side, entry, stop, undefined, 3),
      `Swing ${zone.tag} · swept ${liq.kind === "low" ? "SSL" : "BSL"} · ${side} · 3R · hold through session`,
      0.06,
    );
    if (sig) out.push(sig);
  }
  return out.slice(-4);
}

/** Same swing model on native 1H/4H bars (not folded 15m). */
export function scanSwingNative(cs: Candle[]): IctSignal[] {
  if (cs.length < 24) return [];
  const obs = detectObs(cs);
  const fvgs = detectFvgs(cs);
  const out: IctSignal[] = [];
  for (let k = 16; k < cs.length; k++) {
    const b = cs[k]!;
    const bias = dailyBias(cs, k);
    if (bias === 0) continue;
    if (!inKill(b.t)) continue;
    const a = atr(cs, k);
    const sw1 = swings(cs, 2, 2);
    const side = bias === 1 ? "long" : "short";
    const liq = recentSweep(cs, sw1, k, side, 8);
    if (!liq) continue;
    const ob = [...obs].reverse().find((o) => o.i < k && o.i >= k - 12 && o.dir === bias);
    const fvg = [...fvgs].reverse().find((f) => f.i < k && f.i >= k - 12 && f.dir === bias);
    const zone = ob && fvg && overlap(ob.top, ob.bot, fvg.top, fvg.bot)
      ? { top: Math.min(ob.top, fvg.top), bot: Math.max(ob.bot, fvg.bot), tag: "HTF Unicorn" }
      : ob
        ? { top: ob.top, bot: ob.bot, tag: "HTF OB" }
        : fvg
          ? { top: fvg.top, bot: fvg.bot, tag: "HTF FVG" }
          : null;
    if (!zone) continue;
    const tapped = b.l <= zone.top && b.h >= zone.bot;
    const holds = bias === 1 ? b.c > zone.bot : b.c < zone.top;
    if (!tapped || !holds) continue;
    const entry = (zone.top + zone.bot) / 2;
    const stop = bias === 1 ? zone.bot - a * 0.2 : zone.top + a * 0.2;
    const sig = pack(
      k,
      b.t,
      side,
      "swing",
      entry,
      stop,
      twoR(side, entry, stop, undefined, 3),
      `Swing ${zone.tag} · swept ${liq.kind === "low" ? "SSL" : "BSL"} · ${side} · 3R`,
      0.06,
    );
    if (sig) out.push(sig);
  }
  return out.slice(-4);
}

/** Prior-week high/low raid on 1H. */
export function scanWeekly(cs: Candle[]): IctSignal[] {
  if (cs.length < 80) return [];
  const out: IctSignal[] = [];
  for (let k = 48; k < cs.length; k++) {
    const b = cs[k]!;
    const bias = dailyBias(cs, k);
    if (bias === 0) continue;
    if (!inKill(b.t)) continue;
    const from = Math.max(0, k - 120);
    const prior = cs.slice(from, Math.max(from + 1, k - 24));
    if (prior.length < 24) continue;
    const h = Math.max(...prior.map((x) => x.h));
    const l = Math.min(...prior.map((x) => x.l));
    const a = atr(cs, k);
    const sweptLow = b.l < l && b.c > l && bias !== -1;
    const sweptHigh = b.h > h && b.c < h && bias !== 1;
    const side: "long" | "short" | null = sweptLow ? "long" : sweptHigh ? "short" : null;
    if (!side) continue;
    const conf = cisd(cs, k, side);
    if (!conf.ok) continue;
    const entry = conf.fvg ? (conf.fvg.bot + conf.fvg.top) / 2 : b.c;
    const sweepPx = side === "long" ? Math.min(b.l, l) : Math.max(b.h, h);
    const stop = side === "long" ? sweepPx - a * 0.2 : sweepPx + a * 0.2;
    const sig = pack(
      conf.i,
      cs[conf.i]!.t,
      side,
      "weekly",
      entry,
      stop,
      twoR(side, entry, stop, undefined, 3),
      `Weekly ${side === "long" ? "low" : "high"} raid · CISD · 3R`,
      0.07,
    );
    if (sig) out.push(sig);
  }
  return out.slice(-3);
}

export function styleAllows(style: string, setup: SetupKind): boolean {
  if (style === "sweep") return setup === "sweep" || setup === "amd" || setup === "judas";
  if (style === "scalp") return setup === "scalp" || setup === "silver" || setup === "judas" || setup === "asia";
  if (style === "swing") return setup === "swing" || setup === "weekly" || setup === "breaker" || setup === "ifvg";
  return true;
}

const SETUP_RANK: Record<SetupKind, number> = {
  silver: 0,
  amd: 1,
  judas: 2,
  asia: 3,
  scalp: 4,
  swing: 5,
  weekly: 6,
  sweep: 7,
  breaker: 8,
  ifvg: 9,
  ob: 10,
  fvg: 11,
  div: 12,
  curve: 13,
  published: 14,
};

/** Keep the session models; don't let early OBs spend the day's budget. */
function pickDay(raw: IctSignal[]): IctSignal[] {
  const byDay = new Map<string, IctSignal[]>();
  for (const s of raw) {
    const d = nyParts(s.t).day;
    const arr = byDay.get(d) ?? [];
    arr.push(s);
    byDay.set(d, arr);
  }
  const out: IctSignal[] = [];
  for (const daySigs of byDay.values()) {
    const uniq: IctSignal[] = [];
    for (const s of [...daySigs].sort((a, b) => a.i - b.i)) {
      if (uniq.some((x) => Math.abs(x.i - s.i) < 4 && x.side === s.side)) continue;
      uniq.push(s);
    }
    const pinned = ["silver", "amd", "judas", "scalp", "swing", "weekly"] as const;
    const kept: IctSignal[] = [];
    for (const kind of pinned) {
      const hit = uniq.find((s) => s.setup === kind);
      if (hit && !kept.includes(hit)) kept.push(hit);
    }
    const rest = uniq
      .filter((s) => !pinned.includes(s.setup as (typeof pinned)[number]))
      .sort((a, b) => SETUP_RANK[a.setup] - SETUP_RANK[b.setup] || a.i - b.i);
    let extra = 0;
    for (const s of rest) {
      if (extra >= 1) break;
      if (kept.some((k) => Math.abs(k.i - s.i) < 6)) continue;
      kept.push(s);
      extra += 1;
    }
    out.push(...kept.sort((a, b) => a.i - b.i));
  }
  return out;
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
    let filled = s.setup === "div";
    const dt = cs.length > 1 ? Math.max(60_000, cs[1]!.t - cs[0]!.t) : 15 * 60_000;
    const trail =
      s.setup === "asia" || s.setup === "scalp" || s.setup === "silver" || s.setup === "judas" || s.setup === "amd";
    const hold = trail
      ? Math.max(16, Math.round((3 * 3600_000) / dt))
      : s.setup === "swing" || s.setup === "weekly" || s.setup === "breaker"
        ? 80
        : 32;
    let curStop = s.stop;
    let curTgt = trail ? twoR(s.side, s.entry, s.stop, s.target, 3) : s.target;
    const risk = Math.abs(s.entry - s.stop) || 1;
    let hit1 = false;
    for (let i = s.i + 1; i < cs.length; i++) {
      const c = cs[i]!;
      if (!filled) {
        if (c.l <= s.entry && c.h >= s.entry) filled = true;
        else if (i > s.i + hold) break;
        else continue;
      }
      if (trail) {
        const mfe = s.side === "long" ? c.h - s.entry : s.entry - c.l;
        if (mfe >= risk) {
          hit1 = true;
          curStop = s.side === "long" ? Math.max(curStop, s.entry) : Math.min(curStop, s.entry);
        }
        if (mfe >= risk * 1.2 && i >= 2) {
          if (s.side === "long") {
            const sl = Math.min(cs[i]!.l, cs[i - 1]!.l, cs[i - 2]!.l);
            curStop = Math.max(curStop, sl);
          } else {
            const sh = Math.max(cs[i]!.h, cs[i - 1]!.h, cs[i - 2]!.h);
            curStop = Math.min(curStop, sh);
          }
        }
      }
      if (s.side === "long") {
        if (c.l <= curStop) {
          exit = curStop;
          reason = curStop >= s.entry ? "target" : "stop";
          closedAt = c.t;
          break;
        }
        if (c.h >= curTgt) {
          exit = curTgt;
          reason = "target";
          closedAt = c.t;
          break;
        }
      } else {
        if (c.h >= curStop) {
          exit = curStop;
          reason = curStop <= s.entry ? "target" : "stop";
          closedAt = c.t;
          break;
        }
        if (c.l <= curTgt) {
          exit = curTgt;
          reason = "target";
          closedAt = c.t;
          break;
        }
      }
      if (i > s.i + hold) {
        exit = c.c;
        reason = "time";
        closedAt = c.t;
        break;
      }
    }
    if (!filled) continue;
    const dir = s.side === "long" ? 1 : -1;
    const rawR = ((exit - s.entry) * dir) / Math.abs(s.entry - s.stop);
    // TTrades partial: bank 0.5R at 1R, runner is the rest. BE after 1R is +0.5R not 0.
    const r = hit1 ? 0.5 + 0.5 * rawR : rawR;
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
  const kinds: SetupKind[] = ["silver", "amd", "judas", "asia", "scalp", "sweep", "breaker", "ifvg", "fvg", "ob", "div", "swing", "weekly"];
  const labels: Record<SetupKind, string> = {
    silver: "Silver Bullet 10–11 + 2–3 NY (scalp)",
    amd: "Power of 3 (AMD)",
    judas: "Judas 7–10 NY open fake",
    asia: "Asia KZ / NDOG (HTF only)",
    scalp: "NY PM scalp 1:30–4",
    sweep: "Sweep + CISD (eq H/L)",
    breaker: "Breaker (failed OB flip)",
    ifvg: "Inversion FVG",
    fvg: "FVG CE + OTE 62–79",
    ob: "Order block / Unicorn",
    div: "RSI / hidden / SMT",
    swing: "1H swing OB/FVG 3R",
    weekly: "Weekly high/low raid 3R",
    curve: "Pump.fun early curve",
    published: "Published outlier",
  };
  const notes: Record<SetupKind, string> = {
    silver: "TTrades Silver Bullet 10–11 NY and 2–3 NY. Sweep the 9am hour (AM) or AM session (PM), or CISD off a 9am Asia raid. Partial 0.5R at 1R, runner 2–3R.",
    amd: "Asia range, London wick, NY distribution. 3R, partial at 1R.",
    judas: "NY 7–10 raid of overnight high/low (9am true open included), then CISD reverse. The fake open, not the true NY move.",
    asia: "20:00–02:00 NY continuation in HTF. Trail BE at 1R, runner 3R. Never fade the Asia range.",
    scalp: "PM session high/low raid + CISD. 1.5R, 4h time stop.",
    sweep: "Equal highs/lows then CISD. Sweep alone is not a trade.",
    breaker: "Order block closed through, then retested as the other side.",
    ifvg: "FVG filled the wrong way, then used as continuation.",
    fvg: "Displacement FVG or OTE 62–79 retrace in PD.",
    ob: "Last opposite candle. Unicorn = OB overlapping FVG.",
    div: "Regular and hidden RSI divergence plus BTC/ETH SMT.",
    swing: "Native 1H order block / FVG. 3R, holds the session.",
    weekly: "Prior-week high/low raid on 1H + CISD. 3R swing.",
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
