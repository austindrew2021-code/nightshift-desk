export type DeskMode = "watch" | "live" | "ict" | "zostaff";

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

/** @deprecated use DEFAULT_START_USD — kept so older imports keep compiling */
export const START_USD = DEFAULT_START_USD;
