export type DeskMode = "watch" | "live" | "ict" | "zostaff";
export type IctStyle = "all" | "cisd" | "sweep" | "scalp" | "swing";

export type AgentId = "hunter" | "auditor" | "narrative" | "timing" | "checker";

export type Side = "long" | "short";

export type SetupKind =
  | "curve"
  | "silver"
  | "amd"
  | "fvg"
  | "sweep"
  | "ob"
  | "div"
  | "scalp"
  | "swing"
  | "breaker"
  | "ifvg"
  | "judas"
  | "daily"
  | "weekly"
  | "asia"
  | "published";

export type TapeKind =
  | "scan"
  | "pass"
  | "skip"
  | "veto"
  | "open"
  | "close"
  | "stop"
  | "note";

export type FillOrigin = "live" | "published" | "ict";

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AgentState {
  id: AgentId;
  name: string;
  role: string;
  color: string;
  status: string;
  spark: number[];
  pnl: number;
  lastScore: number;
  busy: boolean;
}

export interface Launch {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  twitter: boolean;
  website: boolean;
  telegram: boolean;
  usdMcap: number;
  createdAt: number;
  complete: boolean;
  replies: number;
  image?: string;
  creator?: string;
  realSol: number;
  virtualSol: number;
  uniqueBuyers: number;
  lastTradeAt: number;
}

export interface ScoredToken {
  launch: Launch;
  ageMin: number;
  curvePct: number;
  uniqueBuyers: number;
  risk: number;
  social: number;
  curveHealth: number;
  diversity: number;
  narrativeFit: number;
  virality: number;
  community: number;
  timingScore: number;
  score: number;
  approved: boolean;
  vetoReason?: string;
  skipReason?: string;
  trueEdge: number;
}

export interface Position {
  id: string;
  symbol: string;
  name: string;
  mint: string;
  setup: SetupKind;
  side: Side;
  openedAt: number;
  entryUsd: number;
  sizeSol: number;
  sizeUsd: number;
  stopPct: number;
  targetR: number;
  markUsd: number;
  pnlSol: number;
  pnlUsd: number;
  peakUsd: number;
  agent: AgentId;
  note: string;
  origin: FillOrigin;
  stopUsd?: number;
  targetUsd?: number;
  liqUsd?: number;
  liqCapped?: boolean;
  quotedEntryUsd?: number;
  grossUsd?: number;
  feeUsd?: number;
  jitoUsd?: number;
  slippagePct?: number;
  virtualSol?: number;
  realSol?: number;
  partialed?: boolean;
  markThru?: number;
  /** Wall clock when the order was accepted. Wicks before this are not a fill. */
  liveAt?: number;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  name: string;
  setup: SetupKind;
  side: Side;
  openedAt: number;
  closedAt: number;
  entryUsd: number;
  exitUsd: number;
  sizeSol: number;
  pnlSol: number;
  pnlUsd: number;
  rMultiple: number;
  reason: "target" | "stop" | "time" | "trail" | "session";
  score: number;
  note: string;
  origin: FillOrigin;
  stopUsd?: number;
  targetUsd?: number;
  liqUsd?: number;
  liquidated?: boolean;
  quotedEntryUsd?: number;
  quotedExitUsd?: number;
  feeUsd?: number;
  jitoUsd?: number;
  slippagePct?: number;
}

export interface TapeEvent {
  id: string;
  t: number;
  kind: TapeKind;
  agent?: AgentId;
  symbol: string;
  text: string;
  tone: "up" | "down" | "mute" | "warn";
}

export interface Gauges {
  follow: number;
  decay: number;
  fill: number;
}

export interface DeskStats {
  scanned: number;
  passed: number;
  taken: number;
  skipped: number;
  vetoed: number;
  wins: number;
  losses: number;
  openCount: number;
  grokCalls: number;
  feesUsd: number;
  jitoUsd: number;
  liqHits: number;
  slInsideLiq: number;
}

export interface EquityPoint {
  t: number;
  v: number;
}

export interface MarketSnapshot {
  fetchedAt: number;
  solUsd: number;
  solChange24h: number;
  btcUsd: number;
  btcChange24h: number;
  fundingSol: number;
  oiSolUsd: number;
  longShortSol: number;
  fearGreed: number;
  fearLabel: string;
  launches: Launch[];
  candles15: Candle[];
  candles1h: Candle[];
  candles5: Candle[];
  books: import("./universe").IctBook[];
  source: string;
  livePump: boolean;
}

export interface SetupOdds {
  setup: SetupKind;
  label: string;
  trades: number;
  wins: number;
  winRate: number;
  avgR: number;
  expectancyR: number;
  notes: string;
}

export const AGENT_META: Record<
  AgentId,
  { name: string; role: string; color: string }
> = {
  hunter: { name: "HUNTER", role: "Launch monitor", color: "var(--color-hunter)" },
  auditor: { name: "AUDITOR", role: "Wallet & risk", color: "var(--color-auditor)" },
  narrative: { name: "NARRATIVE", role: "Meme potential", color: "var(--color-narrative)" },
  timing: { name: "TIMING", role: "Regime & ICT", color: "var(--color-timing)" },
  checker: { name: "CHECKER", role: "Adversarial veto", color: "var(--color-checker)" },
};

export const DEFAULT_START_USD = 1000;
export const START_PRESETS = [100, 250, 500, 1000, 2500, 5000] as const;
export const MIN_START_USD = 10;
export const MAX_START_USD = 1_000_000;

/** grokbot-pumpfun / @zostaff video post */
export const MAX_OPEN = 5;
export const MAX_DAILY_TRADES = 10;
export const DAILY_LOSS_PCT = 0.22;
export const MAX_POS_PCT = 0.08;
export const MAX_SOL_PER_TRADE = 0.1;
export const STOP_PCT = 0.5;
export const TAKE_PROFIT_PCT = 20;
export const TRAIL_PCT = 0.35;
export const MAX_HOLD_MS = 3_600_000;
export const MIN_SCORE = 0.65;

/** ICT paper: 40× cap so a tight A+ stop can still size toward 18% 1R (20× cannot: a 0.14% stop at 20× is a 2.8% 1R). Default 50% margin. 1R = 18%. 20× / 50× are chips. Bank 25% of each +$200. */
export const ICT_LEVERAGE = 40;
export const ICT_MARGIN_PCT = 0.5;
export const ICT_MAX_RISK_PCT = 0.18;
export const ICT_HARD_RISK_PCT = 0.18;
export const ICT_MMR = 0.005;
/** Bank ¾ here (5m wick or 20s last). 0.75 left too many 0.50–0.70R INJ/ZEC deaths. */
export const ICT_PARTIAL_R = 0.5;

/** Isolated liq distance: 1/lev − maintenance. 40× ≈ 2.0%. */
export function ictLiqPct(lev = ICT_LEVERAGE): number {
  return Math.max(0.004, 1 / Math.max(2, lev) - ICT_MMR);
}

export function ictLiqPx(side: Side, entry: number, lev = ICT_LEVERAGE): number {
  const p = ictLiqPct(lev);
  return side === "long" ? entry * (1 - p) : entry * (1 + p);
}

/** Working stop cannot sit past isolated liq. */
export function clampStopToLiq(
  side: Side,
  entry: number,
  stop: number,
  lev = ICT_LEVERAGE,
): { stop: number; liq: number; capped: boolean; pct: number } {
  const liq = ictLiqPx(side, entry, lev);
  const pct = ictLiqPct(lev);
  if (side === "long") {
    const capped = stop < liq;
    return { stop: Math.max(stop, liq), liq, capped, pct };
  }
  const capped = stop > liq;
  return { stop: Math.min(stop, liq), liq, capped, pct };
}

/** 20× only when 40× would sit on liq. Never 10× (that class was 0% WR). 0 = skip. */
export function levForStop(stopPct: number, pref = ICT_LEVERAGE): number {
  const room = Math.max(0.006, stopPct) + ICT_MMR;
  const maxLev = Math.floor(1 / room);
  if (pref > 1 && pref <= maxLev) return pref;
  if (maxLev >= 25) return 25;
  if (maxLev >= 20) return 20;
  return 0;
}
export const BANK_EVERY_USD = 200;
export const BANK_RATE = 0.25;
/** Once equity ≥ this, vault 50% of lifetime profit. 18% 1R stays on the tradable remainder. */
export const SCALE_USD = 600;
export const SCALE_BANK = 0.5;
export const ICT_DAILY_LOSS_PCT = 0.22;

/** @deprecated use DEFAULT_START_USD — kept so older imports keep compiling */
export const START_USD = DEFAULT_START_USD;
