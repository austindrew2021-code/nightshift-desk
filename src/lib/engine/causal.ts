/**
 * Causal signal emission — board row 20.
 *
 * `scanIct` is handed the whole series and scans it in one pass, so a signal it
 * reports at bar `i` may have been built from bars after `i`. Measured: 71% of
 * its signals vanish when the series is truncated at their own bar. `simulateIct`
 * then starts hunting the fill at `i+1`, so entries were placed on information
 * that did not exist yet.
 *
 * This walks the series forward and, at each bar k, shows the scanner ONLY bars
 * up to k. A signal is kept only if the scanner reports it as forming on k
 * itself. That is exactly what a live desk can see, and it is what the app does
 * at runtime anyway — the lookahead only ever corrupted replay and backtests.
 *
 * A rolling window rather than an expanding one: every detector here has bounded
 * lookback (swings, FVGs, ATR 14, RSI 14, the day's Asia range, htfBias), so a
 * window of WINDOW bars carries the full context at O(N * WINDOW) instead of
 * O(N^2).
 */
import { scanIct } from "./ict.ts";
import type { IctSignal } from "./ict.ts";
import type { Candle } from "./types.ts";

/** Bars of context shown to the scanner. Must exceed every detector's lookback. */
export const WINDOW = 240;

export function scanIctCausal(
  cs: Candle[],
  opts?: { skipSwing?: boolean; killZoneOnly?: boolean },
): IctSignal[] {
  const out: IctSignal[] = [];
  const seen = new Set<string>();
  if (cs.length < 60) return out;

  for (let k = 48; k < cs.length; k++) {
    const from = Math.max(0, k - WINDOW + 1);
    const win = cs.slice(from, k + 1);
    if (win.length < 48) continue;
    const last = win.length - 1;
    for (const s of scanIct(win, opts)) {
      // Only a signal the scanner says formed on the newest bar is knowable now.
      if (s.i !== last) continue;
      const key = `${s.setup}-${s.side}-${k}-${s.entry.toFixed(8)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Re-index onto the full series so simulateIct walks the real bars.
      out.push({ ...s, i: k, t: cs[k]!.t });
    }
  }
  return out;
}
