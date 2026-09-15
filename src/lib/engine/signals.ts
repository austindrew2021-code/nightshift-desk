/**
 * Signal generators for the strategy zoo and the walk-forward.
 *
 * Every generator returns a position series (+1/0/-1), one entry per bar, built
 * only from bars at or before each index. Shared so `scripts/zoo.ts` and
 * `scripts/walkforward.ts` test literally the same code rather than two copies
 * that can drift.
 *
 * `Gen` takes a bar series and returns positions; the caller decides how returns
 * and costs are applied.
 */
import { atr, rsiWilder } from "./ict.ts";
import type { Candle } from "./types.ts";

export type Gen = (cs: Candle[]) => number[];

// ── indicator helpers (causal) ──
export const sma = (v: number[], n: number) => {
  const o = new Array<number>(v.length).fill(NaN); let s = 0;
  for (let i = 0; i < v.length; i++) { s += v[i]!; if (i >= n) s -= v[i - n]!; if (i >= n - 1) o[i] = s / n; }
  return o;
};
export const ema = (v: number[], n: number) => {
  const o = new Array<number>(v.length).fill(NaN); const k = 2 / (n + 1);
  for (let i = 0; i < v.length; i++) o[i] = i === 0 ? v[0]! : v[i]! * k + o[i - 1]! * (1 - k);
  return o;
};
export const stdev = (v: number[], n: number) => {
  const o = new Array<number>(v.length).fill(NaN);
  for (let i = n - 1; i < v.length; i++) {
    const w = v.slice(i - n + 1, i + 1); const m = w.reduce((a, b) => a + b, 0) / n;
    o[i] = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  }
  return o;
};
export const rollMax = (v: number[], n: number) => v.map((_, i) => (i < n ? NaN : Math.max(...v.slice(i - n, i))));
export const rollMin = (v: number[], n: number) => v.map((_, i) => (i < n ? NaN : Math.min(...v.slice(i - n, i))));


// ── the families ──
export function maCross(fast: number, slow: number, kind: "sma" | "ema", allowShort: boolean): Gen {
  return (cs) => {
    const c = cs.map((x) => x.c);
    const f = kind === "sma" ? sma(c, fast) : ema(c, fast);
    const s = kind === "sma" ? sma(c, slow) : ema(c, slow);
    return c.map((_, i) => (!isFinite(f[i]!) || !isFinite(s[i]!) ? 0 : f[i]! > s[i]! ? 1 : allowShort ? -1 : 0));
  };
}
export function rsiRevert(n: number, lo: number, hi: number, allowShort: boolean): Gen {
  return (cs) => {
    const r = rsiWilder(cs, n); let pos = 0;
    return cs.map((_, i) => {
      const v = r[i]; if (v === undefined || !isFinite(v)) return (pos = 0);
      if (pos === 0) { if (v < lo) pos = 1; else if (allowShort && v > hi) pos = -1; }
      else if (pos === 1 && v > 50) pos = 0;
      else if (pos === -1 && v < 50) pos = 0;
      return pos;
    });
  };
}
export function macd(fast: number, slow: number, sig: number, allowShort: boolean): Gen {
  return (cs) => {
    const c = cs.map((x) => x.c);
    const line = ema(c, fast).map((v, i) => v - ema(c, slow)[i]!);
    const sl = ema(line.map((v) => (isFinite(v) ? v : 0)), sig);
    return c.map((_, i) => (line[i]! > sl[i]! ? 1 : allowShort ? -1 : 0));
  };
}
export function bollinger(n: number, k: number, mode: "revert" | "breakout", allowShort: boolean): Gen {
  return (cs) => {
    const c = cs.map((x) => x.c); const m = sma(c, n); const sd = stdev(c, n); let pos = 0;
    return c.map((_, i) => {
      if (!isFinite(m[i]!) || !isFinite(sd[i]!)) return (pos = 0);
      const up = m[i]! + k * sd[i]!, dn = m[i]! - k * sd[i]!;
      if (mode === "revert") {
        if (pos === 0) { if (c[i]! < dn) pos = 1; else if (allowShort && c[i]! > up) pos = -1; }
        else if ((pos === 1 && c[i]! >= m[i]!) || (pos === -1 && c[i]! <= m[i]!)) pos = 0;
      } else {
        if (c[i]! > up) pos = 1; else if (allowShort && c[i]! < dn) pos = -1;
        else if ((pos === 1 && c[i]! < m[i]!) || (pos === -1 && c[i]! > m[i]!)) pos = 0;
      }
      return pos;
    });
  };
}
export function donchian(n: number, allowShort: boolean): Gen {
  return (cs) => {
    const hi = rollMax(cs.map((x) => x.h), n), lo = rollMin(cs.map((x) => x.l), n); let pos = 0;
    return cs.map((x, i) => {
      if (!isFinite(hi[i]!) || !isFinite(lo[i]!)) return (pos = 0);
      if (x.c > hi[i]!) pos = 1; else if (x.c < lo[i]!) pos = allowShort ? -1 : 0;
      return pos;
    });
  };
}
export function stochastic(n: number, lo: number, hi: number, allowShort: boolean): Gen {
  return (cs) => {
    const hh = rollMax(cs.map((x) => x.h), n), ll = rollMin(cs.map((x) => x.l), n); let pos = 0;
    return cs.map((x, i) => {
      if (!isFinite(hh[i]!) || !isFinite(ll[i]!) || hh[i]! <= ll[i]!) return (pos = 0);
      const k = ((x.c - ll[i]!) / (hh[i]! - ll[i]!)) * 100;
      if (pos === 0) { if (k < lo) pos = 1; else if (allowShort && k > hi) pos = -1; }
      else if ((pos === 1 && k > 50) || (pos === -1 && k < 50)) pos = 0;
      return pos;
    });
  };
}
export function supertrend(n: number, mult: number, allowShort: boolean): Gen {
  return (cs) => {
    let pos = 0, stop = NaN;
    return cs.map((x, i) => {
      const a = atr(cs, i, n); if (!(a > 0)) return (pos = 0);
      if (pos === 1) { stop = Math.max(stop, x.c - mult * a); if (x.c < stop) { pos = allowShort ? -1 : 0; stop = x.c + mult * a; } }
      else if (pos === -1) { stop = Math.min(stop, x.c + mult * a); if (x.c > stop) { pos = 1; stop = x.c - mult * a; } }
      else { pos = 1; stop = x.c - mult * a; }
      return pos;
    });
  };
}
export function vwapRevert(n: number, k: number, allowShort: boolean): Gen {
  return (cs) => {
    let pos = 0;
    return cs.map((x, i) => {
      if (i < n) return 0;
      const w = cs.slice(i - n + 1, i + 1);
      const vol = w.reduce((s, y) => s + (y.v || 1), 0);
      const vw = w.reduce((s, y) => s + ((y.h + y.l + y.c) / 3) * (y.v || 1), 0) / vol;
      const a = atr(cs, i); if (!(a > 0)) return (pos = 0);
      if (pos === 0) { if (x.c < vw - k * a) pos = 1; else if (allowShort && x.c > vw + k * a) pos = -1; }
      else if ((pos === 1 && x.c >= vw) || (pos === -1 && x.c <= vw)) pos = 0;
      return pos;
    });
  };
}
export function tsMom(n: number, allowShort: boolean): Gen {
  return (cs) => cs.map((x, i) => {
    if (i < n) return 0;
    const past = cs[i - n]!.c;
    return x.c > past ? 1 : allowShort ? -1 : 0;
  });
}
export function volBreakout(k: number, allowShort: boolean): Gen {
  return (cs) => {
    let pos = 0;
    return cs.map((x, i) => {
      const a = atr(cs, i); if (!(a > 0) || i < 2) return (pos = 0);
      const ref = cs[i - 1]!.c;
      if (x.c > ref + k * a) pos = 1; else if (allowShort && x.c < ref - k * a) pos = -1;
      else if (pos !== 0 && Math.abs(x.c - ref) < k * a * 0.25) pos = 0;
      return pos;
    });
  };
}

/**
 * Hurst exponent over a window, by rescaled range. H < 0.5 means anti-persistent
 * (mean-reverting), H > 0.5 trending. This is the one genuinely different IDEA in
 * the TradingView survey: not a new indicator, but switching WHICH family runs
 * based on a measured regime.
 */
export function hurst(cs: Candle[], i: number, n: number): number {
  if (i < n) return 0.5;
  const r: number[] = [];
  for (let k = i - n + 1; k <= i; k++) r.push(Math.log(cs[k]!.c / cs[k - 1]!.c));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  let cum = 0, mn = 0, mx = 0;
  for (const x of r) { cum += x - m; mn = Math.min(mn, cum); mx = Math.max(mx, cum); }
  const range = mx - mn;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length) || 1e-12;
  if (range <= 0) return 0.5;
  return Math.log(range / sd) / Math.log(n);
}

/** Run `revert` while the regime is mean-reverting, `trend` while it is trending. */
export function regimeSwitch(n: number, loH: number, hiH: number, revert: Gen, trend: Gen): Gen {
  return (cs) => {
    const a = revert(cs), b = trend(cs);
    return cs.map((_, i) => {
      const h = hurst(cs, i, n);
      if (h < loH) return a[i] ?? 0;
      if (h > hiH) return b[i] ?? 0;
      return 0;
    });
  };
}

