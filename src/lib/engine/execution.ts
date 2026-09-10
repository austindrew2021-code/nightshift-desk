/**
 * Pump.fun paper execution.
 * Fees match the published program (1% curve fee). Jito is a typical
 * meme-priority tip, not the 10_000-lamport example in the article —
 * that would understate cost. Slippage is constant-product vs the
 * virtual+real SOL the API reports.
 */

export const PUMP_FEE = 0.01;
export const JITO_TIP_SOL = 0.001;
export const VIRTUAL_SOL_FALLBACK = 30;
export const MAX_SLIP = 0.45;

export function solFromLamports(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e6 ? n / 1e9 : n;
}

/** Average fill worse than spot for a buy/sell of `sizeSol` against curve liquidity. */
export function curveSlippage(sizeSol: number, virtualSol: number, realSol: number): number {
  const liq = Math.max(0.35, (Number.isFinite(virtualSol) && virtualSol > 0 ? virtualSol : VIRTUAL_SOL_FALLBACK) + Math.max(0, realSol));
  const x = Math.max(0, sizeSol) / liq;
  return Math.min(MAX_SLIP, x / (1 + x));
}

export interface BuyFill {
  quotedMcap: number;
  fillMcap: number;
  sizeSolGross: number;
  sizeUsdGross: number;
  sizeUsdNet: number;
  sizeSolNet: number;
  feeUsd: number;
  jitoUsd: number;
  slippagePct: number;
  cashDebitUsd: number;
}

export function modelBuy(opts: {
  quotedMcap: number;
  sizeUsd: number;
  solUsd: number;
  virtualSol: number;
  realSol: number;
}): BuyFill {
  const solUsd = Math.max(1e-6, opts.solUsd);
  const gross = Math.max(0, opts.sizeUsd);
  const sizeSolGross = gross / solUsd;
  const feeUsd = gross * PUMP_FEE;
  const jitoUsd = JITO_TIP_SOL * solUsd;
  const net = Math.max(0, gross - feeUsd);
  const slip = curveSlippage(net / solUsd, opts.virtualSol, opts.realSol);
  const quoted = Math.max(50, opts.quotedMcap);
  const fillMcap = quoted * (1 + slip);
  return {
    quotedMcap: quoted,
    fillMcap,
    sizeSolGross,
    sizeUsdGross: gross,
    sizeUsdNet: net,
    sizeSolNet: net / solUsd,
    feeUsd,
    jitoUsd,
    slippagePct: slip,
    cashDebitUsd: gross + jitoUsd,
  };
}

export interface SellFill {
  quotedMcap: number;
  fillMcap: number;
  proceedsUsd: number;
  feeUsd: number;
  jitoUsd: number;
  slippagePct: number;
}

export function modelSell(opts: {
  quotedMcap: number;
  sizeUsdNet: number;
  entryFill: number;
  solUsd: number;
  virtualSol: number;
  realSol: number;
}): SellFill {
  const solUsd = Math.max(1e-6, opts.solUsd);
  const entry = Math.max(1e-9, opts.entryFill);
  const quoted = Math.max(0, opts.quotedMcap);
  const inventory = opts.sizeUsdNet * (quoted / entry);
  const sizeSol = inventory / solUsd;
  const slip = curveSlippage(sizeSol, opts.virtualSol, opts.realSol);
  const fillMcap = quoted * (1 - slip);
  const afterSlip = opts.sizeUsdNet * (fillMcap / entry);
  const feeUsd = afterSlip * PUMP_FEE;
  const jitoUsd = JITO_TIP_SOL * solUsd;
  const proceedsUsd = Math.max(0, afterSlip - feeUsd - jitoUsd);
  return {
    quotedMcap: quoted,
    fillMcap,
    proceedsUsd,
    feeUsd,
    jitoUsd,
    slippagePct: slip,
  };
}

export function fillQuality(slip: number, feeUsd: number, jitoUsd: number, notional: number): number {
  const drag = (feeUsd + jitoUsd) / Math.max(1e-6, notional) + slip;
  return Math.max(0.05, Math.min(0.99, 1 - drag));
}
