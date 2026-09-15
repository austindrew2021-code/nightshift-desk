/**
 * Position sizing under isolated margin, where liquidation is a hard wall.
 *
 * The thing worth internalising: on isolated margin, **leverage does not set
 * position size — risk does.** Size comes from (risk $ / stop distance). Leverage
 * only decides how much margin that notional locks up, and where the liquidation
 * price sits. So "my stop is 2.8% and 40x liquidates at 2%" is not a reason to
 * skip the trade. It is a reason to set THAT ticket to 20x.
 *
 * Fixing leverage at 40x and then rejecting any setup whose stop will not fit
 * inside 2% means the structure of the trade is being dictated by a margin
 * setting. That is backwards, and it systematically throws away exactly the
 * trades with the widest, safest, most structural stops.
 */

/**
 * Maintenance margin rate. Venue- and tier-dependent (KuCoin USDT-M majors sit
 * near 0.5% at small size, higher for low-liquidity symbols and big notionals).
 * Passed in rather than assumed so it can be set per symbol.
 */
export const DEFAULT_MMR = 0.005;

/** How far price must move against an isolated position before liquidation. */
export function liqDistance(leverage: number, mmr = DEFAULT_MMR): number {
  if (!(leverage > 0)) return 0;
  return Math.max(0, 1 / leverage - mmr);
}

/**
 * Highest leverage at which the stop still sits comfortably inside liquidation.
 * `safety` is how much room to leave: 1.5 means liquidation must be at least 50%
 * further away than the stop, which covers the wick that takes out the stop
 * without taking out the position.
 */
export function maxSafeLeverage(stopPct: number, safety = 1.5, mmr = DEFAULT_MMR): number {
  if (!(stopPct > 0)) return 0;
  const needed = stopPct * safety + mmr;
  if (needed <= 0) return 0;
  return 1 / needed;
}

export interface Ticket {
  ok: boolean;
  reason: string;
  /** Leverage to set on this position — not a global setting. */
  leverage: number;
  notionalUsd: number;
  marginUsd: number;
  riskUsd: number;
  stopPct: number;
  liqPct: number;
  /** How many times further away liquidation is than the stop. */
  liqOverStop: number;
}

/**
 * Build one ticket. Risk drives notional; leverage is then chosen as the highest
 * value that keeps liquidation `safety`x beyond the stop, capped by the venue
 * maximum and by the margin actually available.
 */
export function ticket(opts: {
  workingCashUsd: number;
  riskPct: number;
  stopPct: number;
  /** Venue/symbol ceiling, e.g. 40 for majors, 20 for NPC on KuCoin. */
  maxLeverage: number;
  safety?: number;
  mmr?: number;
  /** Fraction of working cash allowed as margin on one position. */
  marginCapPct?: number;
}): Ticket {
  const safety = opts.safety ?? 1.5;
  const mmr = opts.mmr ?? DEFAULT_MMR;
  const marginCapPct = opts.marginCapPct ?? 0.5;
  const cash = Math.max(0, opts.workingCashUsd);
  const stopPct = opts.stopPct;
  const riskUsd = cash * opts.riskPct;
  const bad = (reason: string): Ticket => ({
    ok: false, reason, leverage: 0, notionalUsd: 0, marginUsd: 0,
    riskUsd, stopPct, liqPct: 0, liqOverStop: 0,
  });

  if (!(stopPct > 0)) return bad("stop distance is zero or invalid");
  if (!(cash > 0) || !(riskUsd > 0)) return bad("no working cash");

  // Risk sets the notional. Leverage has no say here.
  const notionalUsd = riskUsd / stopPct;

  const safeLev = maxSafeLeverage(stopPct, safety, mmr);
  if (safeLev < 1) {
    return bad(`stop ${(stopPct * 100).toFixed(2)}% is too wide to survive even 1x`);
  }
  const leverage = Math.min(opts.maxLeverage, Math.floor(safeLev));
  if (leverage < 1) return bad("no leverage setting keeps the stop inside liquidation");

  const marginUsd = notionalUsd / leverage;
  if (marginUsd > cash * marginCapPct) {
    return bad(
      `needs $${marginUsd.toFixed(2)} margin at ${leverage}x, over the ` +
      `${(marginCapPct * 100).toFixed(0)}% cap ($${(cash * marginCapPct).toFixed(2)})`,
    );
  }
  const liqPct = liqDistance(leverage, mmr);
  return {
    ok: true,
    reason: `${leverage}x isolated · liq ${(liqPct * 100).toFixed(2)}% vs stop ${(stopPct * 100).toFixed(2)}%`,
    leverage, notionalUsd, marginUsd, riskUsd, stopPct, liqPct,
    liqOverStop: liqPct / stopPct,
  };
}

/**
 * Simultaneous risk when several positions are open at once.
 *
 * Correlation is the part that gets missed. Crypto majors run 0.8-0.9 correlated
 * in a real flush, so N positions at r% each are close to N*r% of a single bet,
 * not N independent ones. At 18% per 1R and 5 opens that is up to 90% of the book
 * on one candle.
 */
export function simultaneousRisk(opts: {
  riskPct: number;
  openPositions: number;
  sameSideMax: number;
  /** Assumed correlation between open positions during an adverse move. */
  correlation?: number;
}): { worstCasePct: number; effectivePct: number; note: string } {
  const rho = opts.correlation ?? 0.85;
  const n = Math.max(0, opts.openPositions);
  const worst = opts.riskPct * n;
  // Independent bets scale with sqrt(n); perfectly correlated ones scale with n.
  const effN = Math.sqrt(n) + rho * (n - Math.sqrt(n));
  const effective = opts.riskPct * effN;
  return {
    worstCasePct: worst,
    effectivePct: effective,
    note:
      `${n} opens x ${(opts.riskPct * 100).toFixed(0)}% = ${(worst * 100).toFixed(0)}% ` +
      `if they all stop together; ~${(effective * 100).toFixed(0)}% at correlation ${rho}`,
  };
}
