export type DeskMode = "watch" | "live" | "ict" | "zostaff";
export type IctStyle = "all" | "sweep" | "scalp" | "swing";

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
  quotedEntryUsd?: number;
  grossUsd?: number;
  feeUsd?: number;
  jitoUsd?: number;
  slippagePct?: number;
  virtualSol?: number;
  realSol?: number;
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
export const MAX_OPEN = 3;
export const MAX_DAILY_TRADES = 10;
export const DAILY_LOSS_PCT = 0.22;
export const MAX_POS_PCT = 0.08;
export const MAX_SOL_PER_TRADE = 0.1;
export const STOP_PCT = 0.5;
export const TAKE_PROFIT_PCT = 20;
export const TRAIL_PCT = 0.35;
export const MAX_HOLD_MS = 3_600_000;
export const MIN_SCORE = 0.65;

/** ICT paper: 12% of tradable per 1R (not 2%). Bank 50% each +$100. 15x is the notional ceiling. */
/**
 * Venue ceiling for leverage, not a per-trade setting. KuCoin USDT-M majors go
 * to 40x isolated, which is what fills are copied at; NPC caps at 20x there, so
 * pass a lower maxLeverage for it.
 *
 * Raising this from 15 does NOT raise risk. Risk stays ICT_MAX_RISK_PCT of book
 * and notional stays risk/stopDistance — the ceiling only decides whether that
 * notional is affordable in margin, and sizing.ts then drops the leverage per
 * ticket until liquidation sits 1.5x beyond the stop. At 15x a 1% stop needed
 * $80 of margin on a $100 book and was refused outright; at 40x it needs $30 and
 * self-regulates down to 28x/21x as the stop widens. Board row 39.
 */
export const ICT_LEVERAGE = 40;
/**
 * Share of the book a single position may lock up as margin.
 *
 * This used to be half of a global notional cap (`book x ICT_MARGIN_PCT x
 * ICT_LEVERAGE`), which silently shrank any setup whose stop was wide. It is now
 * what its name says: a margin cap. Risk sets notional, sizing.ts picks the
 * per-ticket leverage, and this decides whether the resulting margin is
 * affordable — a ticket that does not fit is refused rather than resized.
 *
 * 0.6 rather than 0.8 on measurement: across 4,000 block-bootstrap paths,
 * dropping deployed margin from 80% to 50-60% raised the MEDIAN 30-day outcome
 * from $34 to ~$80 and cut median drawdown from 87% to ~55%. With expectancy near
 * zero, extra notional buys variance and nothing else. Board rows 36 and 39.
 */
export const ICT_MARGIN_PCT = 0.6;
export const ICT_MAX_RISK_PCT = 0.12;
export const BANK_EVERY_USD = 100;
export const BANK_RATE = 0.5;

/** @deprecated use DEFAULT_START_USD — kept so older imports keep compiling */
export const START_USD = DEFAULT_START_USD;
