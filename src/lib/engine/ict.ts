import type { Candle, ClosedTrade, SetupKind, SetupOdds } from "./types";

/**
 * New York wall-clock time, DST included.
 *
 * This was a flat `4 * 3600_000` ("EDT in September"), which is right from
 * mid-March to the first Sunday in November and an hour out for the rest of the
 * year. Every ICT window hangs off nyHour, so in EST the Silver Bullet fired
 * 09:00-10:00 NY instead of 10:00-11:00 and the engine kept producing a
 * confident, mistimed tape. Ask the timezone database instead of assuming.
 */
const NY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * formatToParts is fast but scanIct calls nyHour once per bar per pass, so
 * memoise by the minute. Bounded — cleared long before it could grow large.
 */
const NY_CACHE = new Map<number, { h: number; m: number; day: string }>();

export function nyParts(t: number): { h: number; m: number; day: string } {
  const key = Math.floor(t / 60_000);
  const hit = NY_CACHE.get(key);
  if (hit) return hit;
  let y = 0, mo = 1, d = 1, h = 0, m = 0;
  for (const part of NY_FMT.formatToParts(new Date(t))) {
    const n = Number(part.value);
    if (part.type === "year") y = n;
    else if (part.type === "month") mo = n;
    else if (part.type === "day") d = n;
    else if (part.type === "hour") h = n % 24;
    else if (part.type === "minute") m = n;
  }
  // Month stays 0-based so the key matches the previous getUTCMonth() format.
  const out = { h, m, day: `${y}-${mo - 1}-${d}` };
  if (NY_CACHE.size > 60_000) NY_CACHE.clear();
  NY_CACHE.set(key, out);
  return out;
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
      // Asia from 20:00 NY belongs to the next trading day.
      day = nyParts(c.t + 24 * 3600_000).day;
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

/**
 * Minimum stop distance, as a multiple of ATR at the signal bar. A stop tighter
 * than this is noise, not risk. Deliberately a sanity floor rather than a tuned
 * parameter: it is not chosen to maximise returns, and it should not be.
 */
export const MIN_STOP_ATR = 0.25;

function pack(
  i: number,
  t: number,
  side: "long" | "short",
  setup: SetupKind,
  entry: number,
  stop: number,
  target: number,
  note: string,
  maxRisk = 0.03,
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
 *  CISD, order-block / unicorn (OB∩FVG), FVG CE, RSI regular + hidden divergence,
 *  equal H/L sweep, NY PM scalp, OTE 62–79, 1H swing.
 *  Sweep alone is not a trade.
 *  Per NY day: Silver / AMD / scalp / swing kept; plus up to 2 continuation.
 */
/**
 * `killZoneOnly` drops signals whose bar falls outside London / NY AM / Silver
 * Bullet / NY PM. This is the published method rather than a tuned filter —
 * TTrades ICT is defined on those windows. Measured on 41 days of 15m across 11
 * books with real costs, out of sample: keeping the 14 non-killzone trades moved
 * average expectancy from +0.227R to -0.073R, because thin-hour bars gap through
 * stops. See bots/BOARD.md row 27.
 */
export function scanIct(
  cs: Candle[],
  opts?: { skipSwing?: boolean; killZoneOnly?: boolean },
): IctSignal[] {
  if (cs.length < 48) return [];
  const asia = buildAsia(cs);
  const fvgs = detectFvgs(cs);
  const obs = detectObs(cs);
  const brks = detectBreakers(cs);
  const ifvgs = detectIfvg(cs);
  const rsi = rsiWilder(cs);
  const sw = swings(cs, 3, 2);
  const signals: IctSignal[] = [];
  const londonRaid = new Map<string, "high" | "low">();

  const add = (sig: IctSignal | null) => {
    if (!sig) return;
    // A stop closer to entry than a fraction of ATR is inside the noise band:
    // ordinary jitter takes it out whatever the thesis says, and because R is
    // normalised by stop distance a routine adverse bar then reports a huge
    // negative R. pack() already rejects stops that are too WIDE (3% of price);
    // nothing rejected ones that were absurdly tight. One amd signal on BTC had
    // a stop 0.0032% of price - about $3 on a $95k chart - and returned -46.4R
    // by itself, which was the whole of amd's -6.70R out-of-sample average.
    // Board row 28.
    const risk = Math.abs(sig.entry - sig.stop);
    if (!(risk > 0)) return;
    const noise = atr(cs, sig.i) * MIN_STOP_ATR;
    if (noise > 0 && risk < noise) return;
    if (signals.some((x) => Math.abs(x.i - sig.i) < 4 && x.side === sig.side && x.setup === sig.setup)) return;
    signals.push(sig);
  };

  for (let i = 24; i < cs.length; i++) {
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
        let side: "long" | "short" | null = sweptLow ? "long" : sweptHigh ? "short" : null;
        let why = side
          ? `swept 9am ${side === "long" ? "low" : "high"}`
          : "";
        // TTrades: if 9am itself was the raid of Asia and 10–11 CISDs away from
        // that extreme (no second sweep), that is still the Silver Bullet.
        if (!side) {
          const asiaR = asia.get(day);
          const nineRaidedHigh = Boolean(asiaR?.asiaReady && nine.h > asiaR.asiaH);
          const nineRaidedLow = Boolean(asiaR?.asiaReady && nine.l < asiaR.asiaL);
          if (nineRaidedHigh && c.c < nine.h && c.c < c.o) {
            side = "short";
            why = "9am Asia-high fail";
          } else if (nineRaidedLow && c.c > nine.l && c.c > c.o) {
            side = "long";
            why = "9am Asia-low fail";
          }
        }
        if (side) {
          const conf = cisd(cs, i, side);
          const want = side === "long" ? 1 : -1;
          const fvg =
            conf.fvg ??
            [...fvgs].reverse().find((f) => f.dir === want && f.i <= (conf.ok ? conf.i : i) && f.i >= i - 8);
          if (conf.ok && fvg) {
            const sweepPx = side === "long" ? Math.min(c.l, nine.l) : Math.max(c.h, nine.h);
            const entry = (fvg.bot + fvg.top) / 2;
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
                `SB 10–11 NY · ${why} · CISD · FVG`,
              ),
            );
          }
        }
      }
    }

    if (isLondon(c.t)) {
      const range = asia.get(day);
      if (range?.asiaReady) {
        const sweptLow = c.l < range.asiaL && c.c > range.asiaL;
        const sweptHigh = c.h > range.asiaH && c.c < range.asiaH;
        let side: "long" | "short" | null = null;
        let sweepPx = 0;
        let note = "";
        if (sweptLow && bias !== -1) {
          side = "long";
          sweepPx = Math.min(c.l, range.asiaL);
          note = "AMD · London raid on Asia low";
        } else if (sweptHigh && bias !== 1) {
          side = "short";
          sweepPx = Math.max(c.h, range.asiaH);
          note = "AMD · London raid on Asia high";
        }
        if (side) {
          const conf = cisd(cs, i, side);
          if (conf.ok && (conf.fvg || true)) {
            const entry = conf.fvg ? (conf.fvg.bot + conf.fvg.top) / 2 : cs[conf.i]!.c;
            const stopPad = (range.asiaH - range.asiaL) * 0.06 || entry * 0.0025;
            const stop = side === "long" ? sweepPx - stopPad : sweepPx + stopPad;
            add(
              pack(
                conf.i,
                cs[conf.i]!.t,
                side,
                "amd",
                entry,
                stop,
                twoR(side, entry, stop, side === "long" ? range.asiaH : range.asiaL, 3),
                `${note} · CISD${conf.fvg ? " · FVG" : ""} · ${bias === 1 ? "bull HTF" : bias === -1 ? "bear HTF" : "flat HTF"} · 3R`,
              ),
            );
          }
        }
      }
    }

    if (isJudas(c.t)) {
      const range = asia.get(day);
      const london = hourRange(cs, day, 2, 5);
      const ovnH = Math.max(range?.asiaH ?? -Infinity, london?.h ?? -Infinity);
      const ovnL = Math.min(range?.asiaL ?? Infinity, london?.l ?? Infinity);
      if (Number.isFinite(ovnH) && Number.isFinite(ovnL) && ovnH > ovnL) {
        const sweptLow = c.l < ovnL && c.c > ovnL;
        const sweptHigh = c.h > ovnH && c.c < ovnH;
        const side: "long" | "short" | null =
          sweptLow ? "long" : sweptHigh ? "short" : null;
        if (side) {
          const conf = cisd(cs, i, side);
          if (conf.ok && conf.fvg) {
            const sweepPx = side === "long" ? Math.min(c.l, ovnL) : Math.max(c.h, ovnH);
            const entry = (conf.fvg.bot + conf.fvg.top) / 2;
            const stopPad = (ovnH - ovnL) * 0.06 || entry * 0.002;
            const stop = side === "long" ? sweepPx - stopPad : sweepPx + stopPad;
            add(
              pack(
                conf.i,
                cs[conf.i]!.t,
                side,
                "judas",
                entry,
                stop,
                twoR(side, entry, stop, side === "long" ? ovnH : ovnL),
                `Judas 7–10 NY · fake ${side === "long" ? "low" : "high"} · CISD · FVG`,
              ),
            );
          }
        }
      }
    }

    // Asia is ICT accumulation. London raids it. Do not trade the Asia session — 7d test −16.7R.

    if (!inKill(c.t) || bias === 0) continue;

    const sideBias: "long" | "short" = bias === 1 ? "long" : "short";
    const liq = recentSweep(cs, sw, i, sideBias, 12);
    const conf = cisd(cs, i, sideBias);
    const contOk = Boolean(liq && conf.ok);

    // Unicorn / advanced OB: last opposite candle overlapping a displacement FVG.
    const recentOb = [...obs].reverse().find((o) => o.i < i && o.i >= i - 18 && o.dir === bias);
    const recentFvg = [...fvgs].reverse().find((f) => f.i < i && f.i >= i - 18 && f.dir === bias);
    if (contOk && recentOb && recentFvg && overlap(recentOb.top, recentOb.bot, recentFvg.top, recentFvg.bot)) {
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
            twoR(side, entry, stop, undefined, 3),
            `Unicorn OB∩FVG · ${side} · ${bias === 1 ? "bull" : "bear"} HTF · 3R`,
          ),
        );
      }
    }

    const br = [...brks].reverse().find((o) => o.i < i && o.i >= i - 36 && o.dir === bias);
    if (contOk && br) {
      const tapped = c.l <= br.top && c.h >= br.bot;
      const holds = bias === 1 ? c.c > br.bot : c.c < br.top;
      if (tapped && holds) {
        const side = bias === 1 ? "long" : "short";
        const entry = (br.top + br.bot) / 2;
        const stop = bias === 1 ? br.bot - a * 0.18 : br.top + a * 0.18;
        add(
          pack(
            i,
            c.t,
            side,
            "breaker",
            entry,
            stop,
            twoR(side, entry, stop),
            `Breaker · failed OB flipped · ${side}`,
          ),
        );
      }
    }

    const inv = [...ifvgs].reverse().find((f) => f.i < i && f.i >= i - 28 && f.dir === bias);
    if (contOk && inv) {
      const tapped = c.l <= inv.top && c.h >= inv.bot;
      const holds = bias === 1 ? c.c > inv.bot : c.c < inv.top;
      if (tapped && holds) {
        const side = bias === 1 ? "long" : "short";
        const entry = (inv.top + inv.bot) / 2;
        const stop = bias === 1 ? inv.bot - a * 0.15 : inv.top + a * 0.15;
        add(
          pack(
            i,
            c.t,
            side,
            "ifvg",
            entry,
            stop,
            twoR(side, entry, stop),
            `iFVG · inverted gap · ${side}`,
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

    if (isNyPm(c.t)) {
      const sess = sessionHiLo(cs, day, 0, 13.5);
      if (sess) {
        const side: "long" | "short" | null =
          c.l < sess.l && c.c > sess.l && bias !== -1
            ? "long"
            : c.h > sess.h && c.c < sess.h && bias !== 1
              ? "short"
              : null;
        if (side) {
          const conf = cisd(cs, i, side);
          if (conf.ok && conf.fvg) {
            const entry = (conf.fvg.bot + conf.fvg.top) / 2;
            const sweepPx = side === "long" ? sess.l : sess.h;
            const stop = side === "long" ? sweepPx - a * 0.12 : sweepPx + a * 0.12;
            add(
              pack(
                conf.i,
                cs[conf.i]!.t,
                side,
                "scalp",
                entry,
                stop,
                twoR(side, entry, stop, undefined, 1.5),
                `PM scalp 1:30–4 NY · session ${side === "long" ? "low" : "high"} · CISD · 1.5R`,
              ),
            );
          }
        }
      }
    }
  }

  if (!opts?.skipSwing) for (const s of scanSwing(cs)) add(s);
  const picked = pickDay(signals);
  return opts?.killZoneOnly ? picked.filter((s) => inKill(s.t)) : picked;
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
    const bias = htfBias(bars, k);
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
    const bias = htfBias(cs, k);
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
    const bias = htfBias(cs, k);
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
      if (extra >= 2) break;
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
        // Asia from 20:00 NY belongs to the next trading day.
        day = nyParts(c.t + 24 * 3600_000).day;
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

/**
 * What a round trip on a major actually costs. Defaults are deliberately
 * mid-range for a retail perp account, not best-case:
 *  - feeRate: taker, per side. 0.05% is typical; makers pay less.
 *  - slipRate: half-spread crossed on each side, as a fraction of price.
 *  - fundingRate8h: perp funding per 8h funding period.
 * Set every field to 0 to reproduce the old frictionless numbers.
 */
export interface IctCosts {
  feeRate: number;
  slipRate: number;
  fundingRate8h: number;
}

export const DEFAULT_ICT_COSTS: IctCosts = {
  feeRate: 0.0005,
  slipRate: 0.0002,
  fundingRate8h: 0.0001,
};

export const ZERO_ICT_COSTS: IctCosts = { feeRate: 0, slipRate: 0, fundingRate8h: 0 };

/**
 * Strategy variants, for `scripts/ict-variants.ts`. Everything defaults off, so
 * omitting this reproduces the shipped behaviour exactly.
 */
export interface IctSimOpts {
  /** Apply the breakeven+trail rule to every setup, not just the intraday ones. */
  trailAll?: boolean;
  /**
   * Disable the shipped trail entirely. It is on by default for asia, scalp,
   * silver and judas — which are the setups with negative out-of-sample
   * expectancy — and once intra-bar order is resolved honestly, trailing rules
   * measure as a clear negative here. trailNone wins over trailAll.
   */
  trailNone?: boolean;
  /** Move the stop to entry once the trade has run 1R in favour. */
  beAt1R?: boolean;
  /** Rescale the target to N*R from entry, overriding the setup's own target. */
  targetMult?: number;
  /** Close at the bar close when an opposing signal fires — "exit on reversal". */
  exitOnOpposing?: boolean;
  /** Signal list searched for those reversals; pass the same list you scanned. */
  opposing?: IctSignal[];
  /**
   * Finer bars (e.g. 5m under a 15m series) used to sequence events INSIDE each
   * coarse bar. Without them a bar that touches both the target and the stop is
   * ambiguous, and any trailing rule resolves it pessimistically — moving the
   * stop up on the same bar it then stops out on. Supply these and the order is
   * known instead of assumed.
   */
  subBars?: Candle[];
}

/**
 * Setups entered at market on the signal rather than on a return to a level.
 * They still cannot fill at the signal bar's close — that price is only known
 * once the bar has closed — so they fill at the NEXT bar's open.
 */
const MARKET_ENTRY: ReadonlySet<SetupKind> = new Set<SetupKind>(["div"]);

export function simulateIct(
  cs: Candle[],
  signals: IctSignal[],
  riskUsd = 10,
  symbol = "SOL",
  name = "Solana",
  costs: IctCosts = DEFAULT_ICT_COSTS,
  opts: IctSimOpts = {},
): IctSimTrade[] {
  const trades: IctSimTrade[] = [];
  // Opposing signals indexed by bar, so the reversal check is O(1) per bar.
  const opposingAt = new Map<number, "long" | "short">();
  if (opts.exitOnOpposing) {
    for (const o of opts.opposing ?? []) opposingAt.set(o.i, o.side);
  }
  const barMs = cs.length > 1 ? Math.max(60_000, cs[1]!.t - cs[0]!.t) : 15 * 60_000;
  // Bucket each fine bar onto its coarse bar, anchored on cs[0] so it does not
  // matter whether the series aligns to an epoch multiple.
  let subIdx: Map<number, Candle[]> | null = null;
  if (opts.subBars?.length && cs.length) {
    const anchor = cs[0]!.t;
    subIdx = new Map();
    for (const sb of opts.subBars) {
      if (sb.t < anchor) continue;
      const bucket = anchor + Math.floor((sb.t - anchor) / barMs) * barMs;
      const arr = subIdx.get(bucket);
      if (arr) arr.push(sb);
      else subIdx.set(bucket, [sb]);
    }
    for (const arr of subIdx.values()) arr.sort((a, b) => a.t - b.t);
  }
  for (const s of signals) {
    let exit = s.entry;
    let reason: ClosedTrade["reason"] = "time";
    let closedAt = cs[cs.length - 1]?.t ?? s.t;
    // Was `filled = s.setup === "div"`, which handed div setups a free fill at
    // the exact signal price whether or not price ever traded there — div was
    // half of all signals and the highest win rate, so this was the single
    // largest source of phantom PnL. Market-entry setups now fill at the next
    // bar's open, which is the first price actually obtainable.
    const marketEntry = MARKET_ENTRY.has(s.setup);
    const nextOpen = cs[s.i + 1]?.o;
    let entryPx = s.entry;
    let filled = false;
    if (marketEntry) {
      if (nextOpen === undefined) continue;
      entryPx = nextOpen;
      filled = true;
    }
    const trail =
      !opts.trailNone &&
      (opts.trailAll ||
        s.setup === "asia" || s.setup === "scalp" || s.setup === "silver" || s.setup === "judas");
    const hold = trail
      ? Math.max(16, Math.round((3 * 3600_000) / barMs))
      : s.setup === "swing" || s.setup === "weekly" || s.setup === "breaker"
        ? 80
        : 32;
    let curStop = s.stop;
    const baseR = Math.abs(s.entry - s.stop);
    let curTgt = opts.targetMult
      ? s.entry + (s.side === "long" ? 1 : -1) * opts.targetMult * baseR
      : trail
        ? twoR(s.side, s.entry, s.stop, s.target, 3)
        : s.target;
    const risk = Math.abs(s.entry - s.stop) || 1;
    for (let i = s.i + 1; i < cs.length; i++) {
      const c = cs[i]!;
      // One coarse bar, resolved as its fine bars when we have them.
      const inner = subIdx?.get(c.t);
      const steps: Candle[] = inner && inner.length ? inner : [c];
      let closed = false;

      for (const st of steps) {
        if (!filled) {
          if (st.l <= entryPx && st.h >= entryPx) filled = true;
          else continue;
        }
        if (opts.beAt1R) {
          const mfe = s.side === "long" ? st.h - entryPx : entryPx - st.l;
          if (mfe >= risk) {
            curStop =
              s.side === "long" ? Math.max(curStop, entryPx) : Math.min(curStop, entryPx);
          }
        }
        if (trail) {
          const mfe = s.side === "long" ? st.h - entryPx : entryPx - st.l;
          if (mfe >= risk) {
            curStop =
              s.side === "long" ? Math.max(curStop, entryPx) : Math.min(curStop, entryPx);
          }
          if (mfe >= risk * 1.2 && i >= 2) {
            if (s.side === "long") {
              curStop = Math.max(curStop, Math.min(cs[i]!.l, cs[i - 1]!.l, cs[i - 2]!.l));
            } else {
              curStop = Math.min(curStop, Math.max(cs[i]!.h, cs[i - 1]!.h, cs[i - 2]!.h));
            }
          }
        }
        if (s.side === "long") {
          if (st.l <= curStop) {
            // A stop is a market order: a bar that OPENED below the stop fills
            // at the open, not at the stop.
            exit = Math.min(st.o, curStop);
            reason = curStop >= entryPx ? "target" : "stop";
            closedAt = st.t;
            closed = true;
            break;
          }
          if (st.h >= curTgt) {
            exit = curTgt;
            reason = "target";
            closedAt = st.t;
            closed = true;
            break;
          }
        } else {
          if (st.h >= curStop) {
            exit = Math.max(st.o, curStop);
            reason = curStop <= entryPx ? "target" : "stop";
            closedAt = st.t;
            closed = true;
            break;
          }
          if (st.l <= curTgt) {
            exit = curTgt;
            reason = "target";
            closedAt = st.t;
            closed = true;
            break;
          }
        }
      }
      if (closed) break;

      if (!filled) {
        if (i > s.i + hold) break;
        continue;
      }
      // Opposing signals are indexed by coarse bar, so this is checked here.
      if (opts.exitOnOpposing) {
        const opp = opposingAt.get(i);
        if (opp && opp !== s.side) {
          exit = c.c;
          reason = "trail";
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
    const stopDist = Math.abs(entryPx - s.stop) || Math.abs(s.entry - s.stop) || 1;
    // Cross the spread on the way in and on the way out.
    const entryFill = entryPx * (1 + dir * costs.slipRate);
    const exitFill = exit * (1 - dir * costs.slipRate);
    const grossR = ((exitFill - entryFill) * dir) / stopDist;
    // Notional is set by risk / stop distance, exactly as ictRiskUsd sizes it.
    const stopPct = stopDist / Math.max(1e-9, entryPx);
    const notional = riskUsd / Math.max(1e-9, stopPct);
    const heldH = Math.max(0, (closedAt - s.t) / 3600_000);
    const costUsd =
      notional * costs.feeRate * 2 + notional * costs.fundingRate8h * (heldH / 8);
    const pnlUsd = grossR * riskUsd - costUsd;
    const r = pnlUsd / Math.max(1e-9, riskUsd);
    trades.push({
      id: `ict-${symbol}-${s.setup}-${s.i}`,
      symbol,
      name,
      setup: s.setup,
      side: s.side,
      openedAt: s.t,
      closedAt,
      entryUsd: entryPx,
      exitUsd: exit,
      sizeSol: riskUsd / stopDist,
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
    silver: "Silver Bullet 10–11 NY (scalp)",
    amd: "Power of 3 (AMD)",
    judas: "Judas 7–9 NY open fake",
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
    silver: "TTrades AM Silver Bullet. Sweep the 9am hour OR CISD off a 9am Asia raid. Scalp 1.5–2R.",
    amd: "Asia range, London wick, NY distribution.",
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
