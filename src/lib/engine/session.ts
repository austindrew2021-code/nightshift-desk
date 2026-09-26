import {
  AGENT_META,
  DAILY_LOSS_PCT,
  DEFAULT_START_USD,
  ICT_LEVERAGE,
  ICT_MARGIN_PCT,
  ICT_MAX_RISK_PCT,
  ICT_HARD_RISK_PCT,
  ICT_PARTIAL_R,
  BANK_EVERY_USD,
  BANK_RATE,
  SCALE_USD,
  SCALE_BANK,
  clampStopToLiq,
  ictLiqPct,
  levForStop,
  MAX_DAILY_TRADES,
  MAX_HOLD_MS,
  MAX_OPEN,
  MAX_POS_PCT,
  MAX_SOL_PER_TRADE,
  STOP_PCT,
  TAKE_PROFIT_PCT,
  TRAIL_PCT,
  type AgentId,
  type AgentState,
  type ClosedTrade,
  type DeskMode,
  type DeskStats,
  type EquityPoint,
  type FillOrigin,
  type Gauges,
  type Launch,
  type MarketSnapshot,
  type Position,
  type ScoredToken,
  type TapeEvent,
} from "./types";
import { agentLine, regimeScore, scoreLive } from "./pipeline";
import { fadingAcceptedBreak, inKill, isFillWindow, isWaveRide, lockRFromMfe, nyHour, nyParts, readRegime, scan5mCisd, scanIct, scanPlayback, scanSmt, scanSwingNative, scanWeekly, simulateIct, styleAllows, exitTells } from "./ict";
import { fillQuality, modelBuy, modelSell } from "./execution";
import { ICT_ASSETS, type IctBook } from "./universe";
import { queueLiveOpen } from "./live-pend";
import {
  ZOSTAFF_LAST_TICK,
  ZOSTAFF_SCANNED,
  buildZostaffPlan,
  zostaffTapeKind,
  type ZAction,
  type ZostaffStep,
} from "./zostaff";

const AGENTS: AgentId[] = ["hunter", "auditor", "narrative", "timing", "checker"];

function blankAgents(): AgentState[] {
  return AGENTS.map((id) => ({
    id,
    name: AGENT_META[id].name,
    role: AGENT_META[id].role,
    color: AGENT_META[id].color,
    status: "idle",
    spark: [0],
    pnl: 0,
    lastScore: 0,
    busy: false,
  }));
}

export interface EngineState {
  mode: DeskMode;
  running: boolean;
  speed: number;
  simT: number;
  wallStarted: number;
  solUsd: number;
  startUsd: number;
  cashUsd: number;
  equityUsd: number;
  peakUsd: number;
  bankedUsd: number;
  agents: AgentState[];
  open: Position[];
  closed: ClosedTrade[];
  tape: TapeEvent[];
  equity: EquityPoint[];
  heatmap: number[];
  gauges: Gauges;
  stats: DeskStats;
  liveQueue: Launch[];
  quotes: Record<string, number>;
  seenMints: string[];
  ictIndex: number;
  ictTrades: ClosedTrade[];
  ictCursor: number;
  ictFilter: string;
  ictSeen: string[];
  ictStyle: import("./types").IctStyle;
  ictUse5m: boolean;
  ictRiskPct: number;
  ictLev: number;
  ictRegime: import("./ict").TapeRegime;
  ictRegimeNote: string;
  ictChopLocked: boolean;
  tickN: number;
  dayLoss: number;
  zPlan: ZostaffStep[];
  zCursor: number;
  zDone: boolean;
  /** This-tick opens for the KuCoin dry/live sidecar. Not a paper book. */
  ictLivePend?: Position[];
}

function blankStats(): DeskStats {
  return {
    scanned: 0,
    passed: 0,
    taken: 0,
    skipped: 0,
    vetoed: 0,
    wins: 0,
    losses: 0,
    openCount: 0,
    grokCalls: 0,
    feesUsd: 0,
    jitoUsd: 0,
    liqHits: 0,
    slInsideLiq: 0,
  };
}

function finite(n: number | undefined, d = 0): number {
  return Number.isFinite(n) ? (n as number) : d;
}

export function clampStart(n: number): number {
  const v = finite(n, DEFAULT_START_USD);
  return Math.min(1_000_000, Math.max(10, Math.round(v)));
}

/** Tradable book (equity minus vault). */
export function tradableUsd(s: EngineState): number {
  return Math.max(0, finite(s.equityUsd, s.startUsd) - finite(s.bankedUsd));
}

/** 18% chip stays 18%. Expand used to bump to 22% and overnight 1Rs became $80–$105. */
export function liveRiskPct(s: EngineState): number {
  return s.ictRiskPct || ICT_MAX_RISK_PCT;
}

/** 20× on 50% is the default 10× notional. 1R follows liveRiskPct. Hard cap = that 1R. */
export function ictRiskUsd(s: EngineState, stopPct = 0.01, levOverride?: number, scale = 1): { risk: number; notional: number } {
  const book = Math.max(s.startUsd * 0.25, tradableUsd(s) || s.startUsd);
  const sp = Math.max(1e-6, stopPct);
  const lev = levOverride || s.ictLev || ICT_LEVERAGE;
  const riskPct = liveRiskPct(s);
  const floor = book * ICT_MARGIN_PCT * lev;
  const cap = book * lev;
  const fromRisk = (book * riskPct) / sp;
  let notional = Math.min(cap, Math.max(floor, fromRisk));
  let risk = notional * sp;
  const hard = book * Math.max(riskPct, ICT_HARD_RISK_PCT);
  if (risk > hard) {
    notional = hard / sp;
    risk = hard;
  }
  const k = Math.min(1, Math.max(0.25, scale));
  return { risk: Math.max(1, risk * k), notional: notional * k };
}

function ictHaltPct(s: EngineState) {
  const r = liveRiskPct(s);
  if (r >= 0.28) return 0.32;
  if (r >= 0.16) return 0.22;
  return 0.28;
}

/** Net ICT PnL for this NY session. Overnight (00–07) halt must not sit out NY AM. */
function ictSessionNet(s: EngineState, now = Date.now()): number {
  const cur = nyParts(now);
  const nyAm = cur.h >= 7;
  return s.closed
    .filter((c) => {
      if (c.origin !== "ict") return false;
      const p = nyParts(c.closedAt);
      if (p.day !== cur.day) return false;
      return (p.h >= 7) === nyAm;
    })
    .reduce((a, c) => a + finite(c.pnlUsd), 0);
}

function ictDayNet(s: EngineState, now = Date.now()): number {
  return ictSessionNet(s, now);
}

function maybeBank(s: EngineState) {
  if (s.mode !== "ict") return;
  const eq = finite(s.equityUsd);
  const lifetime = eq - s.startUsd;
  if (lifetime < BANK_EVERY_USD && eq < SCALE_USD) return;
  let targetVault = lifetime >= BANK_EVERY_USD ? Math.floor(lifetime / BANK_EVERY_USD) * (BANK_EVERY_USD * BANK_RATE) : 0;
  let scale = false;
  if (eq >= SCALE_USD) {
    targetVault = Math.max(targetVault, lifetime * SCALE_BANK);
    scale = true;
  }
  const take = targetVault - finite(s.bankedUsd);
  if (take < 1) return;
  const room = Math.max(0, finite(s.cashUsd) - s.startUsd * 0.25);
  const moved = Math.min(take, room);
  if (moved < 1) return;
  s.bankedUsd = finite(s.bankedUsd) + moved;
  s.cashUsd = finite(s.cashUsd) - moved;
  const trade = finite(s.equityUsd) - s.bankedUsd;
  pushTape(s, {
    t: s.simT || Date.now(),
    kind: "note",
    symbol: "BANK",
    text: scale
      ? `scale $${SCALE_USD} · vault ${(SCALE_BANK * 100).toFixed(0)}% of profit · banked ${moved.toFixed(0)} · vault $${s.bankedUsd.toFixed(0)} · trade $${trade.toFixed(0)} · 18% 1R on tradable`
      : `banked ${moved.toFixed(0)} · 25% of +$${BANK_EVERY_USD} after first $${BANK_EVERY_USD} · vault $${s.bankedUsd.toFixed(0)} · trade $${trade.toFixed(0)}`,
    tone: "up",
  });
}

/** When expansion dies, bank a slice of *excess* working capital. Never take the desk below start. Repeat locks on restore were vacuuming cash. */
function lockVaultOnChop(s: EngineState) {
  if (s.mode !== "ict") return;
  if (s.ictChopLocked) return;
  const equity = finite(s.equityUsd, s.startUsd);
  const floor = Math.max(s.startUsd, equity * 0.5);
  const room = tradableUsd(s) - floor;
  const moved = Math.floor(Math.max(0, room) * 0.25);
  if (moved < 5) {
    s.ictChopLocked = true;
    return;
  }
  s.ictChopLocked = true;
  s.bankedUsd = finite(s.bankedUsd) + moved;
  s.cashUsd = finite(s.cashUsd) - moved;
  for (const p of s.open) {
    if (p.origin !== "ict") continue;
    if (finite(p.pnlUsd) <= 0) continue;
    p.stopUsd = p.entryUsd;
    p.partialed = true;
  }
  pushTape(s, {
    t: s.simT || Date.now(),
    kind: "note",
    symbol: "BANK",
    text: `expand ended · locked $${moved.toFixed(0)} · vault $${s.bankedUsd.toFixed(0)} · working $${tradableUsd(s).toFixed(0)}`,
    tone: "up",
  });
}

/** If restore/chop-lock left cash under start, drip vault back so London can still size 18% 1R. */
function restoreWorkingFloor(s: EngineState) {
  if (s.mode !== "ict") return;
  const floor = s.startUsd;
  const tradable = tradableUsd(s);
  if (tradable >= floor - 0.5) return;
  const give = Math.min(floor - tradable, finite(s.bankedUsd));
  if (give < 1) return;
  s.bankedUsd = finite(s.bankedUsd) - give;
  s.cashUsd = finite(s.cashUsd) + give;
  pushTape(s, {
    t: s.simT || Date.now(),
    kind: "note",
    symbol: "BANK",
    text: `working floor · +$${give.toFixed(0)} from vault · trade $${tradableUsd(s).toFixed(0)} · vault $${s.bankedUsd.toFixed(0)}`,
    tone: "warn",
  });
}

const APLUS_LIVE = new Set(["judas", "silver", "amd", "sweep", "asia", "daily", "scalp"]);

export function createEngine(solUsd = 100, startUsd = DEFAULT_START_USD): EngineState {
  const start = clampStart(startUsd);
  return {
    mode: "watch",
    running: false,
    speed: 8,
    simT: 0,
    wallStarted: 0,
    solUsd,
    startUsd: start,
    cashUsd: start,
    equityUsd: start,
    peakUsd: start,
    bankedUsd: 0,
    agents: blankAgents(),
    open: [],
    closed: [],
    tape: [],
    equity: [{ t: 0, v: start }],
    heatmap: Array.from({ length: 192 }, () => 0),
    gauges: { follow: 0.7, decay: 0.42, fill: 0.78 },
    stats: blankStats(),
    liveQueue: [],
    quotes: {},
    seenMints: [],
    ictIndex: 0,
    ictTrades: [],
    ictCursor: 0,
    ictFilter: "ALL",
    ictSeen: [],
    ictStyle: "cisd",
    ictUse5m: true,
    ictRiskPct: ICT_MAX_RISK_PCT,
    ictLev: ICT_LEVERAGE,
    ictRegime: "chop",
    ictRegimeNote: "warmup",
    ictChopLocked: false,
    tickN: 0,
    dayLoss: 0,
    zPlan: [],
    zCursor: 0,
    zDone: false,
  };
}

let seq = 1;
function nid(prefix: string) {
  seq += 1;
  return `${prefix}-${seq.toString(36)}`;
}

function pushTape(
  s: EngineState,
  e: Omit<EngineState["tape"][number], "id">,
) {
  s.tape = [{ ...e, id: nid("t") }, ...s.tape].slice(0, 80);
}

function setAgent(s: EngineState, id: AgentId, patch: Partial<AgentState>) {
  s.agents = s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a));
}

function bumpSpark(s: EngineState, id: AgentId, delta: number) {
  const d = finite(delta);
  s.agents = s.agents.map((a) => {
    if (a.id !== id) return a;
    const prev = finite(a.spark[a.spark.length - 1]);
    const spark = [...a.spark, prev + d].slice(-28);
    return { ...a, spark, pnl: finite(a.pnl) + d };
  });
}

function canTrade(s: EngineState): string | null {
  if (s.mode === "zostaff") return null;
  if (s.stats.taken >= MAX_DAILY_TRADES) return "daily trade cap";
  if (s.open.length >= MAX_OPEN) return "max open";
  const dailyCap = s.startUsd * DAILY_LOSS_PCT;
  if (s.dayLoss >= dailyCap) return "daily loss limit";
  const exposure = s.open.reduce((a, p) => a + p.sizeUsd, 0);
  if (exposure >= s.startUsd * MAX_POS_PCT * MAX_OPEN) return "max exposure";
  return null;
}

function positionSize(s: EngineState, score: number): number {
  const sc = finite(score, 0.5);
  const room = Math.max(0, s.startUsd * DAILY_LOSS_PCT - finite(s.dayLoss));
  const capUsd = MAX_SOL_PER_TRADE * Math.max(1, s.solUsd);
  const base = capUsd * Math.min(1, Math.max(0.35, sc));
  const usd = Math.max(
    1,
    Math.min(base, room * 0.3, finite(s.cashUsd, s.startUsd) * 0.2, finite(s.equityUsd, s.startUsd) * MAX_POS_PCT),
  );
  return finite(usd, 1);
}

function revalue(s: EngineState, p: Position, next: number): Position {
  const entry = Math.max(1e-9, finite(p.entryUsd, 1));
  const mark = Math.max(0, finite(next, p.markUsd));
  let pnlUsd: number;
  if (p.origin === "live" && p.grossUsd) {
    const sell = modelSell({
      quotedMcap: mark,
      sizeUsdNet: finite(p.sizeUsd),
      entryFill: entry,
      solUsd: s.solUsd,
      virtualSol: p.virtualSol ?? 30,
      realSol: p.realSol ?? 0,
    });
    pnlUsd = sell.proceedsUsd - finite(p.grossUsd) - finite(p.jitoUsd);
  } else {
    const dir = p.side === "short" ? -1 : 1;
    pnlUsd = ((mark - entry) / entry) * finite(p.sizeUsd, 1) * dir;
  }
  return {
    ...p,
    markUsd: mark,
    peakUsd:
      p.side === "short"
        ? Math.min(finite(p.peakUsd, mark) || mark, mark)
        : Math.max(finite(p.peakUsd, mark), mark),
    pnlUsd,
    pnlSol: pnlUsd / Math.max(1e-6, s.solUsd),
  };
}

function closePos(
  s: EngineState,
  p: Position,
  exitUsd: number,
  reason: ClosedTrade["reason"],
) {
  let pnlUsd: number;
  let feeUsd = finite(p.feeUsd);
  let jitoUsd = finite(p.jitoUsd);
  let slip = finite(p.slippagePct);
  let fillExit = exitUsd;
  if (p.origin === "live" && p.grossUsd) {
    const sell = modelSell({
      quotedMcap: exitUsd,
      sizeUsdNet: finite(p.sizeUsd),
      entryFill: Math.max(1e-9, finite(p.entryUsd, 1)),
      solUsd: s.solUsd,
      virtualSol: p.virtualSol ?? 30,
      realSol: p.realSol ?? 0,
    });
    fillExit = sell.fillMcap;
    feeUsd += sell.feeUsd;
    jitoUsd += sell.jitoUsd;
    slip = (slip + sell.slippagePct) / 2;
    s.cashUsd = finite(s.cashUsd) + sell.proceedsUsd;
    pnlUsd = sell.proceedsUsd - finite(p.grossUsd) - finite(p.jitoUsd);
    s.stats.feesUsd += sell.feeUsd;
    s.stats.jitoUsd += sell.jitoUsd;
  } else {
    const dir = p.side === "short" ? -1 : 1;
    pnlUsd = ((exitUsd - p.entryUsd) / Math.max(1e-9, finite(p.entryUsd, 1))) * finite(p.sizeUsd) * dir;
    if (p.origin === "ict") {
      const fee = Math.max(0, finite(p.sizeUsd) * 0.0006);
      feeUsd += fee;
      s.stats.feesUsd = finite(s.stats.feesUsd) + fee;
      pnlUsd -= fee;
      s.cashUsd = finite(s.cashUsd) + finite(pnlUsd);
    } else s.cashUsd = finite(s.cashUsd) + finite(p.sizeUsd) + finite(pnlUsd);
  }
  const pnlSol = finite(pnlUsd) / Math.max(1e-6, s.solUsd);
  const rMultiple = finite(pnlUsd) / Math.max(1e-6, finite(p.sizeUsd) * p.stopPct);
  const liquidated = Boolean(
    p.origin === "ict" &&
      p.liqCapped &&
      reason === "stop" &&
      p.liqUsd &&
      (p.side === "long" ? fillExit <= p.liqUsd * 1.0002 : fillExit >= p.liqUsd * 0.9998),
  );
  if (liquidated) s.stats.liqHits = finite(s.stats.liqHits) + 1;
  s.closed = [
    {
      id: p.id,
      symbol: p.symbol,
      name: p.name,
      setup: p.setup,
      side: p.side,
      openedAt: p.openedAt,
      closedAt: s.simT,
      entryUsd: p.entryUsd,
      exitUsd: fillExit,
      sizeSol: p.sizeSol,
      pnlSol,
      pnlUsd,
      rMultiple,
      reason,
      score: 0.7,
      note: liquidated ? `${p.note} · LIQ` : p.note,
      origin: p.origin,
      stopUsd: p.stopUsd,
      targetUsd: p.targetUsd,
      liqUsd: p.liqUsd,
      liquidated,
      quotedEntryUsd: p.quotedEntryUsd,
      quotedExitUsd: exitUsd,
      feeUsd,
      jitoUsd,
      slippagePct: slip,
    },
    ...s.closed,
  ].slice(0, 80);
  if (pnlUsd > 0.05) s.stats.wins += 1;
  else {
    s.stats.losses += 1;
    s.dayLoss += Math.abs(pnlUsd);
  }
  bumpSpark(s, p.agent, pnlUsd);
  const kind = reason === "stop" ? "stop" : "close";
  const cost = p.origin === "live" ? ` · fees ${feeUsd.toFixed(2)} jito ${jitoUsd.toFixed(2)} slip ${(slip * 100).toFixed(1)}%` : "";
  pushTape(s, {
    t: s.simT,
    kind,
    agent: p.agent,
    symbol: p.symbol,
    text: `${liquidated ? "liq 40x" : reason} ${p.symbol} ${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)} usd${cost}`,
    tone: pnlUsd >= 0 ? "up" : "down",
  });
}

function markLive(s: EngineState) {
  const still: Position[] = [];
  for (const raw of s.open) {
    const quoted = s.quotes[raw.mint];
    const next =
      raw.origin === "live" && Number.isFinite(quoted) && (quoted as number) > 0
        ? (quoted as number)
        : raw.markUsd;
    const p = revalue(s, raw, next);
    if (p.origin !== "live") {
      still.push(p);
      continue;
    }
    const dd = (p.markUsd - p.entryUsd) / Math.max(1e-9, p.entryUsd);
    const trailHit = p.peakUsd > p.entryUsd * 1.4 && p.markUsd < p.peakUsd * (1 - TRAIL_PCT);
    const stopHit = dd <= -p.stopPct;
    const targetHit = dd >= TAKE_PROFIT_PCT;
    const held = s.simT - p.openedAt > MAX_HOLD_MS;
    const timeHit = held && p.pnlUsd <= 0;
    if (stopHit || targetHit || trailHit || timeHit) {
      const reason = stopHit ? "stop" : targetHit ? "target" : trailHit ? "trail" : "time";
      closePos(s, p, p.origin === "live" ? (s.quotes[p.mint] || p.markUsd) : p.markUsd, reason);
    } else {
      still.push(p);
    }
  }
  s.open = still;
  s.stats.openCount = still.length;
}

function openFromScore(s: EngineState, token: ScoredToken, origin: FillOrigin = "live") {
  const block = canTrade(s);
  if (block) {
    s.stats.skipped += 1;
    pushTape(s, {
      t: s.simT,
      kind: "skip",
      agent: "checker",
      symbol: token.launch.symbol,
      text: `brake · ${block}`,
      tone: "warn",
    });
    return;
  }
  const usd = positionSize(s, token.score);
  if (usd < 1 || !Number.isFinite(usd)) return;
  const quoted = Math.max(50, finite(token.launch.usdMcap, 400));
  const buy = modelBuy({
    quotedMcap: quoted,
    sizeUsd: usd,
    solUsd: s.solUsd,
    virtualSol: token.launch.virtualSol,
    realSol: token.launch.realSol,
  });
  if (buy.cashDebitUsd > s.cashUsd + 1e-6) return;
  s.cashUsd -= buy.cashDebitUsd;
  s.stats.feesUsd += buy.feeUsd;
  s.stats.jitoUsd += buy.jitoUsd;
  const pos: Position = {
    id: nid("p"),
    symbol: token.launch.symbol,
    name: token.launch.name,
    mint: token.launch.mint,
    setup: "curve",
    side: "long",
    openedAt: s.simT,
    entryUsd: buy.fillMcap,
    sizeSol: buy.sizeSolNet,
    sizeUsd: buy.sizeUsdNet,
    stopPct: STOP_PCT,
    targetR: 2,
    markUsd: buy.fillMcap,
    pnlSol: 0,
    pnlUsd: -(buy.feeUsd + buy.jitoUsd),
    peakUsd: buy.fillMcap,
    agent: "checker",
    note: `fill $${buy.fillMcap.toFixed(0)} vs print $${quoted.toFixed(0)} · slip ${(buy.slippagePct * 100).toFixed(1)}% · ${token.launch.mint.slice(0, 6)}…`,
    origin,
    quotedEntryUsd: quoted,
    grossUsd: buy.sizeUsdGross,
    feeUsd: buy.feeUsd,
    jitoUsd: buy.jitoUsd,
    slippagePct: buy.slippagePct,
    virtualSol: token.launch.virtualSol,
    realSol: token.launch.realSol,
  };
  s.open = [...s.open, pos];
  s.stats.taken += 1;
  s.stats.openCount = s.open.length;
  s.quotes[token.launch.mint] = quoted;
  s.gauges.follow = s.stats.scanned ? s.stats.passed / Math.max(1, s.stats.scanned) : 0;
  s.gauges.fill = fillQuality(buy.slippagePct, buy.feeUsd, buy.jitoUsd, buy.sizeUsdGross);
  s.gauges.decay = Math.min(0.9, token.curvePct / 100 + 0.2);
  bumpSpark(s, "checker", pos.pnlUsd);
  pushTape(s, {
    t: s.simT,
    kind: "open",
    agent: "checker",
    symbol: token.launch.symbol,
    text: `opened ${pos.sizeSol.toFixed(3)} sol in ${token.launch.symbol} @ fill $${buy.fillMcap.toFixed(0)} (print $${quoted.toFixed(0)}) slip ${(buy.slippagePct * 100).toFixed(1)}% fee ${buy.feeUsd.toFixed(2)} jito ${buy.jitoUsd.toFixed(3)}`,
    tone: "up",
  });
}

function runPipeline(s: EngineState, token: ScoredToken) {
  s.stats.scanned += 1;
  setAgent(s, "hunter", {
    status: agentLine("hunter", token),
    busy: true,
    lastScore: token.curvePct / 100,
  });
  pushTape(s, {
    t: s.simT,
    kind: "scan",
    agent: "hunter",
    symbol: token.launch.symbol,
    text: `scan ${token.launch.symbol}  ${agentLine("hunter", token)}`,
    tone: "mute",
  });

  if (token.skipReason && token.skipReason !== "low_score") {
    s.stats.skipped += 1;
    setAgent(s, "hunter", { status: `skip · ${token.skipReason}`, busy: false });
    return;
  }

  setAgent(s, "auditor", { status: agentLine("auditor", token), lastScore: 1 - token.risk / 10, busy: true });
  setAgent(s, "narrative", { status: agentLine("narrative", token), lastScore: token.narrativeFit, busy: true });
  setAgent(s, "timing", { status: agentLine("timing", token), lastScore: token.timingScore, busy: true });
  setAgent(s, "checker", { status: agentLine("checker", token), lastScore: token.score, busy: true });

  if (token.vetoReason) {
    s.stats.vetoed += 1;
    pushTape(s, {
      t: s.simT,
      kind: "veto",
      agent: "checker",
      symbol: token.launch.symbol,
      text: `veto ${token.launch.symbol} · ${token.vetoReason}`,
      tone: "warn",
    });
    return;
  }
  if (token.skipReason) {
    s.stats.skipped += 1;
    pushTape(s, {
      t: s.simT,
      kind: "skip",
      agent: "checker",
      symbol: token.launch.symbol,
      text: `skip ${token.launch.symbol} · ${token.skipReason}`,
      tone: "mute",
    });
    return;
  }
  s.stats.passed += 1;
  pushTape(s, {
    t: s.simT,
    kind: "pass",
    agent: "checker",
    symbol: token.launch.symbol,
    text: `pass ${token.launch.symbol}  score ${token.score.toFixed(2)}`,
    tone: "up",
  });
  openFromScore(s, token, "live");
}

function applyZAction(s: EngineState, a: ZAction) {
  if (a.type === "scanned") {
    s.stats.scanned = Math.max(s.stats.scanned, a.n);
    return;
  }
  if (a.type === "done") {
    s.zDone = true;
    s.running = false;
    setAgent(s, "hunter", { status: "published run complete", busy: false });
    return;
  }
  if (a.type === "mark") {
    s.open = s.open.map((p) => (p.id === a.id ? revalue(s, p, a.markUsd) : p));
    return;
  }
  if (a.type === "open") {
    const usd = a.sizeSol * s.solUsd;
    if (usd > s.cashUsd + 1e-6) {
      pushTape(s, {
        t: s.simT,
        kind: "skip",
        agent: a.agent,
        symbol: a.symbol,
        text: `skip ${a.symbol} · cash ${s.cashUsd.toFixed(2)} < size ${usd.toFixed(2)}`,
        tone: "warn",
      });
      return;
    }
    s.cashUsd -= usd;
    const pos: Position = {
      id: a.id,
      symbol: a.symbol,
      name: a.name,
      mint: `published:${a.id}`,
      setup: "published",
      side: "long",
      openedAt: s.simT,
      entryUsd: a.entryUsd,
      sizeSol: a.sizeSol,
      sizeUsd: usd,
      stopPct: 0.5,
      targetR: 2,
      markUsd: a.entryUsd,
      pnlSol: 0,
      pnlUsd: 0,
      peakUsd: a.entryUsd,
      agent: a.agent,
      note: a.note,
      origin: "published",
    };
    s.open = [...s.open, pos];
    s.stats.taken += 1;
    s.stats.openCount = s.open.length;
    bumpSpark(s, a.agent, 0);
    pushTape(s, {
      t: s.simT,
      kind: "open",
      agent: a.agent,
      symbol: a.symbol,
      text: `opened ${a.sizeSol.toFixed(3)} sol in ${a.symbol} · ${a.note}`,
      tone: "up",
    });
    return;
  }
  if (a.type === "close") {
    const p = s.open.find((x) => x.id === a.id);
    if (p) {
      s.open = s.open.filter((x) => x.id !== a.id);
      closePos(s, { ...p, note: a.text }, a.exitUsd, a.reason);
      s.stats.openCount = s.open.length;
    }
    return;
  }
  if (a.type === "fee") {
    const usd = a.sol * s.solUsd;
    s.cashUsd = Math.max(0, finite(s.cashUsd) - usd);
    s.stats.scanned = Math.max(s.stats.scanned, ZOSTAFF_SCANNED);
    pushTape(s, {
      t: s.simT,
      kind: "note",
      agent: "checker",
      symbol: "FEES",
      text: a.text,
      tone: "warn",
    });
    return;
  }
  const tone =
    a.type === "veto" ? "warn" : a.type === "note" ? (a.tone === "warn" ? "warn" : "mute") : "mute";
  const text = a.type === "note" ? a.text : a.type === "skip" || a.type === "veto" || a.type === "scan" ? a.text : "";
  const symbol = a.type === "note" ? "DESK" : "symbol" in a ? a.symbol : "DESK";
  if (a.type === "skip") s.stats.skipped += 1;
  if (a.type === "veto") s.stats.vetoed += 1;
  pushTape(s, {
    t: s.simT,
    kind: zostaffTapeKind(a),
    agent: "hunter",
    symbol,
    text,
    tone,
  });
}

function tickZostaff(s: EngineState) {
  if (!s.zPlan.length) {
    s.zPlan = buildZostaffPlan(
      s.startUsd,
      s.solUsd,
      s.liveQueue.map((l) => l.symbol).filter(Boolean),
    );
  }
  const tick = s.tickN;
  while (s.zCursor < s.zPlan.length && s.zPlan[s.zCursor]!.tick <= tick) {
    const step = s.zPlan[s.zCursor]!;
    for (const a of step.actions) applyZAction(s, a);
    s.zCursor += 1;
  }
  s.stats.scanned = Math.min(
    ZOSTAFF_SCANNED,
    Math.max(s.stats.scanned, Math.floor((tick / ZOSTAFF_LAST_TICK) * ZOSTAFF_SCANNED)),
  );
  s.gauges.follow = 11 / 16;
  s.gauges.decay = 0.63;
  s.gauges.fill = 0.79;
  const busy = !s.zDone;
  s.agents = s.agents.map((a) => ({ ...a, busy }));
}

function tickIct(s: EngineState, market: MarketSnapshot | null) {
  if (market) ingestIct(s, market);
  markIct(s, market);
  while (s.ictCursor < s.ictTrades.length) {
    const tr = s.ictTrades[s.ictCursor]!;
    s.ictCursor += 1;
    s.stats.scanned += 4;
    s.stats.taken += 1;
    s.cashUsd += tr.pnlUsd;
    if (tr.pnlUsd > 0.05) s.stats.wins += 1;
    else {
      s.stats.losses += 1;
      s.dayLoss += Math.abs(tr.pnlUsd);
    }
    bumpSpark(s, "timing", tr.pnlUsd);
    pushTape(s, {
      t: tr.openedAt,
      kind: "open",
      agent: "timing",
      symbol: tr.symbol,
      text: `${tr.side} ${tr.symbol} @ ${tr.entryUsd.toFixed(tr.entryUsd < 2 ? 5 : 2)}  ${tr.note}`,
      tone: "mute",
    });
    pushTape(s, {
      t: tr.closedAt,
      kind: tr.reason === "stop" ? "stop" : "close",
      agent: "timing",
      symbol: tr.symbol,
      text: `${reasonLabel(tr.reason)} ${tr.side} ${tr.symbol}  ${tr.pnlUsd >= 0 ? "+" : ""}${tr.pnlUsd.toFixed(2)} usd  ${tr.rMultiple.toFixed(2)}R  ${tr.setup}`,
      tone: tr.pnlUsd >= 0 ? "up" : "down",
    });
    s.closed = [tr, ...s.closed];
    s.gauges.follow = s.stats.taken ? s.stats.wins / s.stats.taken : 0;
    s.gauges.fill = 0.8;
    s.gauges.decay = 0.35;
    setAgent(s, "timing", {
      status: `${tr.symbol} ${tr.setup} ${tr.side} ${tr.rMultiple.toFixed(2)}R`,
      lastScore: Math.max(0, Math.min(1, (tr.rMultiple + 1) / 3)),
      busy: true,
    });
  }
  if (s.open.some((p) => p.origin === "ict")) {
    setAgent(s, "timing", {
      status: `live · ${s.open.filter((p) => p.origin === "ict").length} open · waiting 15m`,
      busy: true,
    });
  } else if (s.ictCursor >= s.ictTrades.length) {
    setAgent(s, "timing", {
      status: "live forward · waiting next 15m A+",
      busy: false,
    });
  }
}

function ictTakePartial(s: EngineState, p: Position, exitUsd: number, frac: number) {
  const take = Math.max(0, finite(p.sizeUsd) * frac);
  if (take < 1) return;
  const dir = p.side === "short" ? -1 : 1;
  let pnlUsd = ((exitUsd - p.entryUsd) / Math.max(1e-9, finite(p.entryUsd, 1))) * take * dir;
  const fee = Math.max(0, take * 0.0006);
  pnlUsd -= fee;
  s.stats.feesUsd = finite(s.stats.feesUsd) + fee;
  s.cashUsd = finite(s.cashUsd) + pnlUsd;
  p.sizeUsd = Math.max(0, finite(p.sizeUsd) - take);
  p.sizeSol = p.sizeUsd / Math.max(1e-6, s.solUsd);
  p.partialed = true;
  const r = finite(p.sizeUsd + take) > 0 ? pnlUsd / Math.max(1e-6, take * p.stopPct) : 1;
  s.closed = [
    {
      id: `${p.id}-p1`,
      symbol: p.symbol,
      name: p.name,
      setup: p.setup,
      side: p.side,
      openedAt: p.openedAt,
      closedAt: s.simT,
      entryUsd: p.entryUsd,
      exitUsd,
      sizeSol: take / Math.max(1e-6, s.solUsd),
      pnlSol: pnlUsd / Math.max(1e-6, s.solUsd),
      pnlUsd,
      rMultiple: r,
      reason: "target",
      score: 0.7,
      note: `${p.note} · ¾ @ ${ICT_PARTIAL_R}R`,
      origin: p.origin,
      stopUsd: p.stopUsd,
      targetUsd: p.targetUsd,
      liqUsd: p.liqUsd,
    },
    ...s.closed,
  ].slice(0, 80);
  if (pnlUsd > 0.05) s.stats.wins += 1;
  bumpSpark(s, p.agent, pnlUsd);
  pushTape(s, {
    t: s.simT,
    kind: "close",
    agent: p.agent,
    symbol: p.symbol,
    text: `¾ @ ${ICT_PARTIAL_R}R ${p.symbol} ${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)} · runner on`,
    tone: "up",
  });
  maybeBank(s);
}

export function markIct(s: EngineState, market: MarketSnapshot | null) {
  const books = market?.books ?? [];
  const trailSet = new Set(["asia", "scalp", "silver", "judas", "amd", "daily", "sweep"]);
  for (const p of [...s.open]) {
    if (p.origin !== "ict") continue;
    if (!s.open.some((x) => x.id === p.id)) continue;
    const b = books.find((x) => x.symbol === p.symbol || x.id === p.symbol);
    const last = b?.last || b?.candles15[b.candles15.length - 1]?.c;
    if (!last) continue;
    const series = (b?.candles5 && b.candles5.length > 8 ? b.candles5 : b?.candles15) ?? [];
    const c = series[series.length - 1];
    const opened = p.openedAt || 0;
    const thru = p.markThru || 0;
    const dt = series.length > 1 ? Math.max(60_000, series[1]!.t - series[0]!.t) : 5 * 60_000;
    const path = series.filter((bar) => (!opened || bar.t + dt > opened) && bar.t > thru);
    const risk = Math.max(1e-9, p.entryUsd * p.stopPct);
    let stopPx = p.stopUsd ?? (p.side === "long" ? p.entryUsd - risk : p.entryUsd + risk);
    let tgtPx =
      p.targetUsd ??
      (p.side === "long" ? p.entryUsd + risk * p.targetR : p.entryUsd - risk * p.targetR);
    const trail = trailSet.has(p.setup);
    let dead = false;
    // Empty path must NOT replay the ¾ bar (fallback [c] was closing the ¼ at BE the next tick).
    const bars = path.length ? path : !thru && c ? [c] : [];
    if (!bars.length) {
      p.markUsd = last;
      p.pnlUsd =
        ((last - p.entryUsd) / Math.max(1e-9, p.entryUsd)) * finite(p.sizeUsd) * (p.side === "long" ? 1 : -1);
      continue;
    }
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]!;
      const forming = i === bars.length - 1;
      const live = forming && last > 0 && Math.abs(last / Math.max(1e-9, bar.c) - 1) < 0.02;
      const entryBar = opened > bar.t && opened < bar.t + dt;
      let hi = entryBar ? (live ? Math.max(p.entryUsd, last) : Math.max(p.entryUsd, bar.c)) : live ? Math.max(bar.h, last) : bar.h;
      let lo = entryBar ? (live ? Math.min(p.entryUsd, last) : Math.min(p.entryUsd, bar.c)) : live ? Math.min(bar.l, last) : bar.l;
      const born = p.liveAt || 0;
      if (born > 0 && bar.t + dt <= born) {
        if (!forming) p.markThru = bar.t;
        continue;
      }
      if (born > 0 && bar.t <= born && born < bar.t + dt) {
        hi = last;
        lo = last;
      }
      // INJ/ZEC class: wick 0.50–0.70R then death. Bank ¾ at 0.50R + BE before SL.
      if (trail && !p.partialed) {
        const mfe = p.side === "long" ? hi - p.entryUsd : p.entryUsd - lo;
        if (mfe >= risk * ICT_PARTIAL_R) {
          const px = p.side === "long" ? p.entryUsd + risk * ICT_PARTIAL_R : p.entryUsd - risk * ICT_PARTIAL_R;
          const run = (p.side === "long" && finite(b?.change24h) >= 0.12) || (p.side === "short" && finite(b?.change24h) <= -0.12);
          ictTakePartial(s, p, px, run ? 0.25 : 0.75);
          stopPx = p.side === "long" ? p.entryUsd + risk * 0.25 : p.entryUsd - risk * 0.25;
          tgtPx = p.side === "long" ? p.entryUsd + risk * 5 : p.entryUsd - risk * 5;
          p.stopUsd = stopPx;
          p.targetUsd = tgtPx;
          p.targetR = 5;
          p.note = `${p.note} · runner${run ? " · keep ¾ (24h run)" : ""}`;
        }
      }
      if (p.side === "long" && lo <= stopPx) {
        s.open = s.open.filter((x) => x.id !== p.id);
        closePos(s, p, stopPx, stopPx >= p.entryUsd ? "target" : "stop");
        dead = true;
        break;
      }
      if (p.side === "short" && hi >= stopPx) {
        s.open = s.open.filter((x) => x.id !== p.id);
        closePos(s, p, stopPx, stopPx <= p.entryUsd ? "target" : "stop");
        dead = true;
        break;
      }
      if (!forming) p.markThru = bar.t;
      if (trail && p.partialed) {
        const mfe = p.side === "long" ? hi - p.entryUsd : p.entryUsd - lo;
        const wave = isWaveRide(p.side, mfe, risk, finite(b?.change24h));
        const lock = lockRFromMfe(mfe, risk, wave);
        if (lock >= 0) {
          const lockPx = p.side === "long" ? p.entryUsd + lock * risk : p.entryUsd - lock * risk;
          stopPx = p.side === "long" ? Math.max(stopPx, lockPx) : Math.min(stopPx, lockPx);
        }
        const far = wave ? 20 : 5;
        tgtPx = p.side === "long" ? p.entryUsd + risk * far : p.entryUsd - risk * far;
        p.stopUsd = stopPx;
        p.targetUsd = tgtPx;
        p.targetR = far;
      } else if (trail && !p.partialed) {
        tgtPx = p.side === "long" ? p.entryUsd + risk : p.entryUsd - risk;
        p.targetUsd = tgtPx;
        p.targetR = 1;
      }
      if (p.side === "long" && hi >= tgtPx) {
        s.open = s.open.filter((x) => x.id !== p.id);
        closePos(s, p, tgtPx, "target");
        dead = true;
        break;
      }
      if (p.side === "short" && lo <= tgtPx) {
        s.open = s.open.filter((x) => x.id !== p.id);
        closePos(s, p, tgtPx, "target");
        dead = true;
        break;
      }
    }
    if (dead) continue;
    const heldMs = Date.now() - (p.openedAt || 0);
    const hour = nyHour(c?.t ?? Date.now());
    const openedH = nyHour(p.openedAt || 0);
    const lastMfe = p.side === "long" ? last - p.entryUsd : p.entryUsd - last;
    const peakPx =
      p.side === "short"
        ? Math.min(finite(p.peakUsd, last) || last, last)
        : Math.max(finite(p.peakUsd, last), last);
    p.peakUsd = peakPx;
    const peakMfe = p.side === "long" ? peakPx - p.entryUsd : p.entryUsd - peakPx;
    if (trail && !p.partialed && lastMfe >= risk * ICT_PARTIAL_R) {
      const px = p.side === "long" ? p.entryUsd + risk * ICT_PARTIAL_R : p.entryUsd - risk * ICT_PARTIAL_R;
      ictTakePartial(s, p, px, 0.75);
      stopPx = p.side === "long" ? p.entryUsd + risk * 0.25 : p.entryUsd - risk * 0.25;
      tgtPx = p.side === "long" ? p.entryUsd + risk * 5 : p.entryUsd - risk * 5;
      p.stopUsd = stopPx;
      p.targetUsd = tgtPx;
      p.targetR = 5;
      p.note = `${p.note} · runner`;
    }
    // TAO-class: +1R on last, then giveback to SL. If the peak was real, fade = momentum died.
    if (peakMfe >= risk * 0.75 && lastMfe <= risk * 0.25) {
      s.open = s.open.filter((x) => x.id !== p.id);
      closePos(s, p, last, lastMfe >= 0 ? "target" : "time");
      pushTape(s, {
        t: Date.now(),
        kind: "note",
        symbol: p.symbol,
        text: `fade ${p.symbol} · peak ${(peakMfe / risk).toFixed(2)}R → ${(lastMfe / risk).toFixed(2)}R · momentum lost`,
        tone: "warn",
      });
      continue;
    }
    // Never tagged ¾ (0.50R), two closed 5m against → scratch. Do not wait for −1R.
    if (!p.partialed && peakMfe < risk * ICT_PARTIAL_R && series.length > 4) {
      const closed = series.filter((bar) => bar.t > opened + 30_000).slice(0, -1);
      if (closed.length >= 2) {
        const lastTwo = closed.slice(-2);
        const against = lastTwo.every((bar) =>
          p.side === "long" ? bar.c < p.entryUsd : bar.c > p.entryUsd,
        );
        if (against) {
          s.open = s.open.filter((x) => x.id !== p.id);
          closePos(s, p, last, "time");
          pushTape(s, {
            t: Date.now(),
            kind: "note",
            symbol: p.symbol,
            text: `dead CISD ${p.symbol} · 2 bars against · never ${ICT_PARTIAL_R.toFixed(2)}R · scratch`,
            tone: "warn",
          });
          continue;
        }
      }
    }
    const scalp = p.setup === "scalp" || p.setup === "sweep" || p.setup === "judas" || p.setup === "amd";
    if (scalp) {
      const wave = isWaveRide(p.side, Math.max(0, lastMfe), risk, finite(b?.change24h));
      if (!p.partialed && heldMs > 2 * 3600_000) {
        s.open = s.open.filter((x) => x.id !== p.id);
        closePos(s, p, last, "time");
        continue;
      }
      if (p.partialed && heldMs > 4 * 3600_000 && !wave) {
        s.open = s.open.filter((x) => x.id !== p.id);
        closePos(s, p, last, "time");
        continue;
      }
      const asiaOpen = openedH >= 20 || openedH < 2;
      const kzOver =
        (asiaOpen && hour >= 2 && hour < 7) ||
        (openedH >= 2 && openedH < 5 && hour >= 5 && hour < 7) ||
        (openedH >= 7 && openedH < 11 && hour >= 11 && hour < 13.5) ||
        (openedH >= 13.5 && openedH < 16 && hour >= 16 && hour < 20);
      if (kzOver && !p.partialed && lastMfe < risk * 0.5) {
        s.open = s.open.filter((x) => x.id !== p.id);
        closePos(s, p, last, "time");
        continue;
      }
      if (peakMfe >= risk * 0.5 && !wave && b?.candles5 && b.candles5.length >= 80) {
        const flip = scan5mCisd(b.candles5).find(
          (x) => x.side !== p.side && x.t >= (p.openedAt || 0) && Date.now() - x.t <= 12 * 60_000,
        );
        const tell = exitTells(b.candles5, p.side, p.openedAt || 0);
        if (flip || tell) {
          s.open = s.open.filter((x) => x.id !== p.id);
          closePos(s, p, last, "time");
          pushTape(s, {
            t: Date.now(),
            kind: "note",
            symbol: p.symbol,
            text: `fade ${p.symbol} · ${flip ? "flip CISD" : tell} · peak ${(peakMfe / risk).toFixed(2)}R`,
            tone: "warn",
          });
          continue;
        }
      }
    }
    if (trail && p.setup === "asia") {
      const hour = nyHour(c?.t ?? Date.now());
      const mfe = p.side === "long" ? last - p.entryUsd : p.entryUsd - last;
      if (hour >= 2 && hour < 7 && mfe < risk) {
        s.open = s.open.filter((x) => x.id !== p.id);
        closePos(s, p, last, "time");
        continue;
      }
    }
    s.open = s.open.map((x) => (x.id === p.id ? { ...revalue(s, x, last), stopUsd: stopPx, targetUsd: tgtPx } : x));
  }
  s.stats.openCount = s.open.length;
}

function reasonLabel(r: ClosedTrade["reason"]) {
  return r;
}

/** Last ~40m volume vs the hour before. SUI/ONE ghosts and thin Asia prints dry up before they dump. */
function volDried(cs?: { v: number }[]) {
  if (!cs || cs.length < 36) return false;
  const recent = cs.slice(-9, -1);
  const base = cs.slice(-33, -9);
  const avg = (xs: { v: number }[]) => xs.reduce((n, x) => n + (x.v || 0), 0) / Math.max(1, xs.length);
  const r = avg(recent);
  const b = avg(base);
  return b > 0 && r < b * 0.28;
}

export function ingestIct(s: EngineState, market: MarketSnapshot) {
  const books: IctBook[] =
    market.books && market.books.length
      ? market.books
      : [
          {
            id: "SOL",
            symbol: "SOL",
            name: "Solana",
            last: market.solUsd,
            change24h: market.solChange24h,
            candles15: market.candles15,
            source: "okx",
          },
        ];
  const filtered = books;
  const btc = books.find((b) => b.id === "BTC");
  const eth = books.find((b) => b.id === "ETH");
  const riskFlat = ictRiskUsd(s, 0.01).risk;
  const now = Date.now();
  const liveFromOpen = now - 12 * 60_000;
  const liveFromClosed = now - 15 * 60_000;
  const capBase = Math.max(s.startUsd, tradableUsd(s));
  const cap = capBase * (s.mode === "ict" ? ictHaltPct(s) : DAILY_LOSS_PCT);
  const dayNet = s.mode === "ict" ? ictDayNet(s, now) : -finite(s.dayLoss);
  const oneR = capBase * liveRiskPct(s);
  const nyAm = nyParts(now).h >= 7;
  const sess = nyAm ? "NY AM" : "overnight";
  let riskScale = 1;
  if (dayNet <= -cap || dayNet - oneR <= -cap) {
    const today = nyParts(now).day;
    const notes = s.tape.filter((t) => {
      if (nyParts(t.t).day !== today) return false;
      return t.text?.startsWith("daily halt") || t.text?.startsWith("session halt") || t.text?.startsWith("resume halt");
    });
    const stuck = notes.some((t) => t.text?.startsWith("resume halt"));
    const first = notes.filter((t) => !t.text?.startsWith("resume halt")).at(-1);
    const coolMs = 90 * 60_000;
    const cooled = !!first && now - first.t >= coolMs;
    const resumeFrom = (first?.t ?? now) + coolMs;
    const resumeNet = s.closed
      .filter((c) => c.origin === "ict" && c.closedAt >= resumeFrom && nyParts(c.closedAt).day === today)
      .reduce((a, c) => a + finite(c.pnlUsd), 0);
    if (stuck || !cooled || resumeNet <= -cap) {
      const second = stuck || (cooled && resumeNet <= -cap);
      const tag = second ? "resume halt" : "session halt";
      const lastHalt = s.tape.find((t) => t.text?.startsWith(tag));
      if (!lastHalt || now - lastHalt.t > 2 * 3600_000) {
        pushTape(s, {
          t: now,
          kind: "note",
          symbol: "ICT",
          text: second
            ? `resume halt · ${sess} · another cap down after the cool-off · net $${dayNet.toFixed(0)} · vault safe · not Reset`
            : `session halt · ${sess} · net $${dayNet.toFixed(0)} · cap -$${cap.toFixed(0)} · 90m then full · vault safe · not Reset`,
          tone: "warn",
        });
      }
      return;
    }
    const lastResume = s.tape.find((t) => t.text?.startsWith("resume · full"));
    if (!lastResume || now - lastResume.t > 6 * 3600_000) {
      pushTape(s, {
        t: now,
        kind: "note",
        symbol: "ICT",
        text: `resume · full size · halt cooled 90m · morning loss stays · one stop does not end the session · not Reset`,
        tone: "info",
      });
    }
  }
  if (s.ictStyle === "cisd") {
    const armed = s.tape.find((t) => t.text?.startsWith("15m CISD live"));
    if (!armed || now - armed.t > 6 * 3600_000) {
      pushTape(s, {
        t: now,
        kind: "note",
        symbol: "ICT",
        text: `15m CISD live · bar close is accepted for 30m · same A+ rules · not Reset`,
        tone: "info",
      });
    }
    const dryNote = s.tape.find((t) => t.text?.startsWith("wick already at"));
    if (!dryNote) {
      pushTape(s, {
        t: now,
        kind: "note",
        symbol: "ICT",
        text: `wick already at 0.5R is not an entry · same-second close is not a fill · not Reset`,
        tone: "info",
      });
    }
    const deadNote = s.tape.find((t) => t.text?.startsWith("dead before the fill"));
    if (!deadNote) {
      pushTape(s, {
        t: now,
        kind: "note",
        symbol: "ICT",
        text: `dead before the fill is not a trade · two bars already against · not Reset`,
        tone: "info",
      });
    }
    const lateNote = s.tape.find((t) => t.text?.startsWith("no order if it dies"));
    if (!lateNote) {
      pushTape(s, {
        t: now,
        kind: "note",
        symbol: "ICT",
        text: `no order if it dies in the same second · not Reset`,
        tone: "info",
      });
    }
    const wickBefore = s.tape.find((t) => t.text?.startsWith("wick before the fill"));
    if (!wickBefore) {
      pushTape(s, {
        t: now,
        kind: "note",
        symbol: "ICT",
        text: `wick before the fill is not the fill · not Reset`,
        tone: "info",
      });
    }
    const stay = s.tape.find((t) => t.text?.startsWith("a scratch stays a scratch"));
    if (!stay) {
      pushTape(s, {
        t: now,
        kind: "note",
        symbol: "ICT",
        text: `a scratch stays a scratch · the prior bar already at 0.5R is not an entry · not Reset`,
        tone: "info",
      });
    }
  }
  let added = 0;
  const fresh: ClosedTrade[] = [];
  const liveBooks = filtered.filter((b) => b.candles15.length >= 40);
  s.stats.scanned = Math.max(s.stats.scanned, liveBooks.length);
  const ref = liveBooks.find((b) => b.id === "BTC") ?? liveBooks[0];
  if (ref) {
    const prev = s.ictRegime;
    const rg = readRegime(ref.candles15, prev, ref.candles1h);
    if (prev === "expand" && rg.regime !== "expand") lockVaultOnChop(s);
    if (rg.regime === "expand") s.ictChopLocked = false;
    s.ictRegime = rg.regime;
    s.ictRegimeNote = rg.note;
    restoreWorkingFloor(s);
  }
  for (const b of liveBooks) {
    const lastT = b.candles15[b.candles15.length - 1]?.t ?? 0;
    const corr = b.id === "BTC" ? eth : btc;
    const extra =
      corr && corr.id !== b.id && s.ictStyle !== "cisd" ? scanSmt(b.candles15, corr.candles15, corr.symbol) : [];
    const s15 =
      s.ictStyle === "cisd"
        ? b.candles15.length >= 80
          ? scan5mCisd(b.candles15)
              .filter((sig) => styleAllows(s.ictStyle, sig.setup) && !isFillWindow(sig.t))
              .map((sig) => ({ ...sig, note: sig.note.replaceAll("5m", "15m") }))
          : []
        : [...scanIct(b.candles15, { extra: 0 }), ...extra].filter((x) => styleAllows(s.ictStyle, x.setup));
    if (s.ictStyle !== "cisd") {
      for (const sig of scanPlayback(b.candles15, b.candles1h)) {
        if (!styleAllows(s.ictStyle, sig.setup)) continue;
        if (s15.some((x) => x.side === sig.side && Math.abs(x.t - sig.t) < 45 * 60_000)) continue;
        s15.push(sig);
      }
    }
    const s5: typeof s15 = [];
    const s1h: typeof s15 = [];
    if (
      s.ictUse5m !== false &&
      (s.ictStyle === "all" || s.ictStyle === "scalp" || s.ictStyle === "sweep" || s.ictStyle === "cisd") &&
      b.candles5 &&
      b.candles5.length >= 48
    ) {
      for (const sig of scanIct(b.candles5, { skipSwing: true })) {
        if (!styleAllows(s.ictStyle, sig.setup)) continue;
        if (sig.setup === "silver" || sig.setup === "scalp" || sig.setup === "judas" || sig.setup === "amd" || sig.setup === "sweep") {
          s5.push({ ...sig, note: `${sig.note} · 5m` });
        }
      }
      for (const sig of scan5mCisd(b.candles5)) {
        if (!styleAllows(s.ictStyle, sig.setup)) continue;
        s5.push({ ...sig, note: sig.note.includes("5m") ? sig.note : `${sig.note} · 5m` });
      }
      if (s.ictStyle !== "cisd") {
        for (const sig of scanPlayback(b.candles5, b.candles15)) {
          if (!styleAllows(s.ictStyle, sig.setup)) continue;
          if (s5.some((x) => x.side === sig.side && Math.abs(x.t - sig.t) < 45 * 60_000)) continue;
          s5.push({ ...sig, note: sig.note.includes("5m") ? sig.note : `${sig.note} · 5m` });
        }
      }
    }
    if (s.ictStyle === "swing" && b.candles1h && b.candles1h.length >= 24) {
      for (const sig of [...scanSwingNative(b.candles1h), ...scanWeekly(b.candles1h)]) {
        if (!styleAllows(s.ictStyle, sig.setup)) continue;
        s1h.push({ ...sig, note: `${sig.note} · 1H` });
      }
    }
    const sim = [
      ...simulateIct(b.candles15, s15, riskFlat, b.symbol, b.name, { keep: 0.25, targetR: 5, mode: "ratchet" }),
      ...(b.candles5 ? simulateIct(b.candles5, s5, riskFlat, b.symbol, b.name, { keep: 0.25, targetR: 5, mode: "ratchet" }) : []),
      ...(b.candles1h ? simulateIct(b.candles1h, s1h, riskFlat, b.symbol, b.name, { keep: 0.25, targetR: 5, mode: "ratchet" }) : []),
    ].map((t) => ({
      ...t,
      origin: "ict" as const,
      pnlSol: t.pnlUsd / Math.max(1e-6, s.solUsd),
    }));
    sim.sort((a, b) => {
      const rank = (x: string) => (x === "scalp" || x === "judas" ? 0 : x === "sweep" ? 1 : 2);
      return rank(a.setup) - rank(b.setup);
    });
    const MEME = new Set(["FARTCOIN", "BONK", "WIF", "PEPE", "FLOKI", "PENGU", "MARSCOIN"]);
    for (const t of sim) {
      const lastT = b.candles15[b.candles15.length - 1]?.t ?? 0;
      const stillOpen = t.reason === "time" && t.closedAt >= lastT - 60_000;
      const on15 = t.note.includes("15m");
      const fromOpen = on15 ? now - 30 * 60_000 : liveFromOpen;
      const fromClosed = on15 ? now - 35 * 60_000 : liveFromClosed;
      if (stillOpen) {
        if (t.openedAt < fromOpen) continue;
      } else if (t.openedAt < fromClosed || t.closedAt < fromClosed) {
        continue;
      }
      const key = `${t.symbol}-${t.side}-${t.openedAt}`;
      if (s.ictSeen.includes(key)) continue;
      if (s.open.some((p) => p.origin === "ict" && p.symbol === t.symbol)) continue;
      if (fresh.some((f) => f.symbol === t.symbol)) continue;
      if (
        s.closed.some(
          (c) =>
            c.origin === "ict" &&
            c.symbol === t.symbol &&
            Math.abs(c.openedAt - t.openedAt) < 45 * 60_000,
        )
      )
        continue;
      if (MEME.has(t.symbol)) continue;
      if (!ICT_ASSETS.some((a) => a.id === t.symbol) && !t.note.includes("OTE")) continue;
      const bodies = (b.candles5 || b.candles15 || []).slice(-5, -1);
      const mid = bodies.length
        ? bodies.reduce((a, c) => a + c.c, 0) / bodies.length
        : b.last || t.entryUsd;
      if (mid > 0 && Math.abs(t.entryUsd / mid - 1) > 0.02) continue;
      if (stillOpen && volDried(b.candles5)) continue;
      const cooled = s.closed.some(
        (c) =>
          c.origin === "ict" &&
          c.symbol === t.symbol &&
          c.reason === "stop" &&
          now - c.closedAt < 12 * 60_000,
      );
      if (cooled) continue;
      const sameSideOpen = s.open.filter((p) => p.origin === "ict" && p.side === t.side);
      const rangeFade = t.setup === "daily" || t.setup === "weekly" || t.setup === "sweep";
      if (rangeFade && sameSideOpen.length >= 1) continue;
      if (!rangeFade && sameSideOpen.length >= 2) continue;
      if (stillOpen) {
        if (!APLUS_LIVE.has(t.setup)) continue;
        if (
          s.open.some((p) => p.id === t.id || (p.origin === "ict" && p.symbol === t.symbol)) ||
          s.open.length >= MAX_OPEN
        )
          continue;
        const trail = t.setup === "asia" || t.setup === "scalp" || t.setup === "silver" || t.setup === "judas" || t.setup === "amd" || t.setup === "daily" || t.setup === "sweep";
        const stopPctRaw = Math.abs(t.entryUsd - t.stop) / Math.max(1e-9, t.entryUsd);
        let lev = s.ictLev || ICT_LEVERAGE;
        let clamped = clampStopToLiq(t.side, t.entryUsd, t.stop, lev);
        if (clamped.capped && APLUS_LIVE.has(t.setup) && !t.note.includes("Panic")) {
          const drop = levForStop(stopPctRaw, lev);
          if (drop >= 20 && drop < lev) {
            lev = drop;
            clamped = clampStopToLiq(t.side, t.entryUsd, t.stop, lev);
          }
        }
        if (clamped.capped) continue;
        if (fadingAcceptedBreak(b.candles15, t.side, b.last || t.entryUsd)) continue;
        const fill = b.last || t.entryUsd;
        const stopDist0 = Math.abs(t.entryUsd - t.stop);
        if (stopDist0 > 0) {
          const adverse = t.side === "long" ? t.entryUsd - fill : fill - t.entryUsd;
          if (adverse > 0.35 * stopDist0) continue;
          const favor = t.side === "long" ? fill - t.entryUsd : t.entryUsd - fill;
          const frame = (on15 ? b.candles15 : b.candles5) ?? [];
          const already = frame.slice(-2).some((w) => {
            const extreme = t.side === "long" ? w.h : w.l;
            const span = t.side === "long" ? extreme - t.entryUsd : t.entryUsd - extreme;
            return span >= ICT_PARTIAL_R * stopDist0;
          });
          if (favor >= ICT_PARTIAL_R * stopDist0 || already) {
            s.ictSeen = [...s.ictSeen, key];
            continue;
          }
        }
        const deadSeries = (b.candles5 && b.candles5.length > 8 ? b.candles5 : b.candles15) ?? [];
        const prior = deadSeries.filter((bar) => bar.t > t.openedAt + 30_000).slice(0, -1);
        if (prior.length >= 2) {
          const lastTwo = prior.slice(-2);
          const against = lastTwo.every((bar) => (t.side === "long" ? bar.c < t.entryUsd : bar.c > t.entryUsd));
          if (against) {
            s.ictSeen = [...s.ictSeen, key];
            continue;
          }
        }
        const cs5 = b.candles5 || [];
        const si = cs5.findIndex((c) => Math.abs(c.t - t.openedAt) < 4 * 60_000);
        if (si >= 0) {
          const cisdC = cs5[si]!;
          let failed = false;
          for (let k = si + 1; k <= Math.min(cs5.length - 1, si + 2); k++) {
            const n = cs5[k]!;
            if (n.t >= t.openedAt) break;
            if (t.side === "long" && n.c < cisdC.c) failed = true;
            if (t.side === "short" && n.c > cisdC.c) failed = true;
          }
          if (failed) continue;
        }
        const ch = finite(b.change24h);
        if (t.side === "long" && ch <= -0.08) continue;
        if (t.side === "long" && t.note.includes("Panic") && ch >= 0.08) continue;
        // Fade the DT-in-Bear-OB playback on a green day. Do not 5m-CISD short a +12% tape (NEAR).
        if (t.side === "short" && ch >= 0.12 && !t.note.includes("Playback")) continue;
        const stopPx = clamped.stop;
        const stopDist = Math.abs(t.entryUsd - stopPx);
        const stopPct = stopDist / Math.max(1e-9, t.entryUsd);
        const sized = ictRiskUsd(s, stopPct, lev, riskScale);
        const sizeUsd = sized.notional;
        const mark = b.last || t.entryUsd;
        const dir = t.side === "short" ? -1 : 1;
        const pnlUsd = ((mark - t.entryUsd) / Math.max(1e-9, t.entryUsd)) * sizeUsd * dir;
        const targetUsd = trail
          ? t.side === "long"
            ? t.entryUsd + stopDist * 5
            : t.entryUsd - stopDist * 5
          : t.target;
        const liqPct = (clamped.pct * 100).toFixed(1);
        const liqNote = clamped.capped ? ` · LIQ cap ${liqPct}%` : ` · LIQ ${liqPct}% SL inside`;
        if (!clamped.capped) s.stats.slInsideLiq = finite(s.stats.slInsideLiq) + 1;
        s.open = [
          ...s.open,
          {
            id: t.id,
            symbol: t.symbol,
            name: t.name,
            mint: `ict:${t.symbol}`,
            setup: t.setup,
            side: t.side,
            openedAt: t.openedAt,
            entryUsd: t.entryUsd,
            sizeSol: sizeUsd / Math.max(1e-6, s.solUsd),
            sizeUsd,
            stopPct,
            targetR: trail ? 5 : Math.abs(t.target - t.entryUsd) / Math.max(1e-9, stopDist),
            markUsd: mark,
            pnlSol: pnlUsd / Math.max(1e-6, s.solUsd),
            pnlUsd,
            peakUsd: mark,
            agent: "timing",
            note: trail
              ? `${t.note} · ¾@${ICT_PARTIAL_R}R trail 5R · ${lev}x${liqNote}`
              : `${t.note} · ${lev}x${liqNote}`,
            origin: "ict",
            stopUsd: stopPx,
            targetUsd,
            liqUsd: clamped.liq,
            liqCapped: clamped.capped,
            liveAt: now,
          },
        ];
        const opened = s.open[s.open.length - 1]!;
        queueLiveOpen(opened);
        s.ictLivePend = [...(s.ictLivePend || []), { ...opened }];
        s.stats.taken += 1;
        s.stats.openCount = s.open.length;
        const openFee = Math.max(0, sizeUsd * 0.0006);
        s.cashUsd = finite(s.cashUsd) - openFee;
        s.stats.feesUsd = finite(s.stats.feesUsd) + openFee;
        s.ictSeen = [...s.ictSeen, key];
        pushTape(s, {
          t: s.simT,
          kind: "open",
          agent: "timing",
          symbol: t.symbol,
          text: `live ${t.side} ${t.symbol} @ ${t.entryUsd.toFixed(t.entryUsd < 0.01 ? 8 : t.entryUsd < 2 ? 5 : 2)} · LIQ ${clamped.liq.toFixed(t.entryUsd < 0.01 ? 8 : t.entryUsd < 2 ? 5 : 2)} (${liqPct}%)${clamped.capped ? " · SL capped" : " · SL inside"} · ${t.note}`,
          tone: "up",
        });
        added += 1;
        continue;
      }
      // Already closed. Booking it pays the paper book for a move we could not send.
      if (s.ictStyle === "cisd") {
        s.ictSeen = [...s.ictSeen, key];
        continue;
      }
      if (t.closedAt < liveFromClosed) continue;
      if (s.open.some((p) => p.origin === "ict" && p.symbol === t.symbol)) continue;
      s.ictSeen = [...s.ictSeen, key];
      fresh.push({
        ...t,
        stopUsd: t.stop,
        targetUsd: t.target,
      });
      added += 1;
    }
  }
  if (!fresh.length && added === 0) return;
  fresh.sort((a, b) => a.openedAt - b.openedAt);
  s.ictTrades = [...s.ictTrades, ...fresh];
  if (added) {
    pushTape(s, {
      t: s.simT,
      kind: "note",
      symbol: s.ictFilter,
      text: `ICT live · +${added} since session start · history stays on the chart, not the $ book`,
      tone: "mute",
    });
  }
}

function nextUnseen(s: EngineState): Launch | null {
  let waiting = 0;
  for (const l of s.liveQueue) {
    if (s.seenMints.includes(l.mint)) continue;
    const ageMin = Math.max(0, (Date.now() - l.createdAt) / 60000);
    const tooNew = ageMin < 2;
    const empty = l.uniqueBuyers < 5;
    const dead = l.complete || !l.symbol || l.symbol === "?";
    if (tooNew || empty || dead) {
      s.seenMints = [...s.seenMints, l.mint].slice(-400);
      s.stats.skipped += 1;
      s.stats.scanned += 1;
      waiting += 1;
      continue;
    }
    return l;
  }
  if (waiting && s.tickN % 8 === 0) {
    setAgent(s, "hunter", {
      status: `waiting · ${waiting} too new or empty`,
      busy: false,
    });
  }
  return null;
}

function tickMeme(s: EngineState, market: MarketSnapshot | null) {
  markLive(s);
  const timing = regimeScore(market);
  setAgent(s, "timing", { status: `regime ${timing.toFixed(2)}`, lastScore: timing, busy: true });
  if (s.mode === "live") {
    setAgent(s, "hunter", {
      status: s.liveQueue.length ? "live poll · waiting next mint batch" : "waiting for pump.fun",
      busy: false,
    });
    return;
  }

  const burst = s.speed >= 8 ? 6 : 4;
  let processed = 0;
  for (let i = 0; i < burst; i++) {
    const l = nextUnseen(s);
    if (!l) {
      if (processed === 0 && s.tickN % 12 === 0) {
        setAgent(s, "hunter", {
          status: s.liveQueue.length ? "queue drained · waiting for next mint" : "waiting for pump.fun",
          busy: false,
        });
      }
      break;
    }
    s.seenMints = [...s.seenMints, l.mint].slice(-400);
    const token = scoreLive(l, timing);
    runPipeline(s, token);
    processed += 1;
  }
  s.agents = s.agents.map((a) => ({
    ...a,
    busy: a.id === "hunter" ? processed > 0 : a.busy,
  }));
}

function scanLiveBatch(s: EngineState, market: MarketSnapshot | null) {
  const timing = regimeScore(market);
  setAgent(s, "timing", { status: `regime ${timing.toFixed(2)}`, lastScore: timing, busy: true });
  let processed = 0;
  while (processed < 40) {
    const l = nextUnseen(s);
    if (!l) break;
    s.seenMints = [...s.seenMints, l.mint].slice(-400);
    runPipeline(s, scoreLive(l, timing));
    processed += 1;
    if (s.open.length >= MAX_OPEN) break;
  }
  setAgent(s, "hunter", {
    status: processed ? `batch ${processed} · ${s.stats.taken} fills` : "live poll · no new mints",
    busy: processed > 0,
  });
}

export function ingestLaunches(s: EngineState, launches: Launch[]) {
  s.liveQueue = launches;
  for (const l of launches) {
    if (l.usdMcap > 0) s.quotes[l.mint] = l.usdMcap;
  }
}

export function applyQuotes(s: EngineState, quotes: Record<string, number>) {
  for (const [mint, mcap] of Object.entries(quotes)) {
    if (Number.isFinite(mcap) && mcap > 0) s.quotes[mint] = mcap;
  }
  if (s.mode === "live" || s.mode === "watch") markLive(s);
}

export function applyMarket(s: EngineState, m: MarketSnapshot) {
  if (s.mode !== "zostaff" || s.tickN < 4) {
    s.solUsd = m.solUsd || s.solUsd;
  }
  ingestLaunches(s, m.launches);
  if (s.mode === "live" || s.mode === "watch") markLive(s);
  if (s.mode === "live" && s.running) scanLiveBatch(s, m);
}

function repairIctCash(s: EngineState) {
  if (finite(s.cashUsd) >= 0) return;
  const closedPnl = s.closed
    .filter((t) => t.origin === "ict")
    .reduce((acc, t) => acc + finite(t.pnlUsd), 0);
  const next = Math.max(0, s.startUsd + closedPnl - finite(s.bankedUsd));
  const was = finite(s.cashUsd);
  s.cashUsd = next;
  pushTape(s, {
    t: s.simT || Date.now(),
    kind: "note",
    symbol: "ICT",
    text: `ICT cash repaired · was ${was.toFixed(0)} · now $${next.toFixed(0)}`,
    tone: "warn",
  });
}

/** The first close for an entry wins. A later copy of the book cannot reopen it and pay it. */
export function buryResurrected(s: EngineState, kept: ClosedTrade[]): void {
  const groups = new Map<string, ClosedTrade[]>();
  for (const c of kept) {
    if (c.origin !== "ict" || !c.id) continue;
    const key = `${c.symbol}|${c.side}|${c.openedAt}`;
    const g = groups.get(key) ?? [];
    if (!g.some((x) => x.id === c.id)) g.push(c);
    groups.set(key, g);
  }
  for (const [key, rows] of groups) {
    const [symbol, side, openedRaw] = key.split("|");
    const openedAt = Number(openedRaw);
    s.open = s.open.filter(
      (p) => !(p.origin === "ict" && p.symbol === symbol && p.side === side && Math.abs(p.openedAt - openedAt) < 90_000),
    );
    const same = s.closed.filter(
      (x) => x.origin === "ict" && x.symbol === symbol && x.side === side && Math.abs(x.openedAt - openedAt) < 90_000,
    );
    const stamp = (xs: ClosedTrade[]) =>
      xs
        .map((x) => `${x.id}:${finite(x.pnlUsd).toFixed(2)}`)
        .sort()
        .join(",");
    if (stamp(same) === stamp(rows)) continue;
    for (const x of same) {
      s.cashUsd = finite(s.cashUsd) - finite(x.pnlUsd);
      if (x.pnlUsd > 0.05) s.stats.wins = Math.max(0, s.stats.wins - 1);
      else {
        s.stats.losses = Math.max(0, s.stats.losses - 1);
        s.dayLoss = Math.max(0, finite(s.dayLoss) - Math.abs(x.pnlUsd));
      }
    }
    s.closed = s.closed.filter(
      (x) => !(x.origin === "ict" && x.symbol === symbol && x.side === side && Math.abs(x.openedAt - openedAt) < 90_000),
    );
    for (const c of rows) {
      s.cashUsd = finite(s.cashUsd) + finite(c.pnlUsd);
      if (c.pnlUsd > 0.05) s.stats.wins += 1;
      else {
        s.stats.losses += 1;
        s.dayLoss = finite(s.dayLoss) + Math.abs(c.pnlUsd);
      }
    }
    s.closed = [...rows, ...s.closed].slice(0, 80);
    pushTape(s, {
      t: s.simT || Date.now(),
      kind: "note",
      symbol: "ICT",
      text: `restored ${symbol} · a scratch cannot be paid later · not Reset`,
      tone: "warn",
    });
  }
}

export function tick(s: EngineState, market: MarketSnapshot | null): EngineState {
  if (!s.running) return s;
  s.tickN += 1;
  if (s.mode === "live" || s.mode === "ict") {
    s.simT = Date.now();
  } else {
    const stepMs = 8_000 * Math.max(1, 8 / s.speed);
    s.simT += stepMs;
  }

  s.heatmap = s.heatmap.map((v, i) => {
    const pulse = s.tickN % 11 === i % 11 ? 1 : v * 0.86;
    return pulse;
  });
  if (s.liveQueue.length) {
    const cell = s.tickN % s.heatmap.length;
    s.heatmap[cell] = 1;
  }

  if (s.mode === "zostaff") tickZostaff(s);
  else if (s.mode === "ict") {
    tickIct(s, market);
    repairIctCash(s);
  } else tickMeme(s, market);

  const openPnl = s.open.reduce((acc, p) => acc + finite(p.pnlUsd), 0);
  s.cashUsd = finite(s.cashUsd, s.startUsd);
  s.equityUsd = finite(s.cashUsd + openPnl + finite(s.bankedUsd), s.startUsd);
  maybeBank(s);
  s.equityUsd = finite(s.cashUsd + openPnl + finite(s.bankedUsd), s.startUsd);
  s.peakUsd = Math.max(finite(s.peakUsd, s.startUsd), s.equityUsd);
  if (s.tickN % 2 === 0) {
    s.equity = [...s.equity, { t: s.simT, v: s.equityUsd }].slice(-180);
  }
  return s;
}

export function resetEngine(
  mode: DeskMode,
  solUsd: number,
  startUsd: number,
  launches: Launch[] = [],
  ictFilter = "ALL",
): EngineState {
  const s = createEngine(solUsd, startUsd);
  s.mode = mode;
  s.running = true;
  s.simT = Date.now();
  s.wallStarted = Date.now();
  s.equity = [{ t: s.simT, v: s.startUsd }];
  s.ictFilter = ictFilter;
  ingestLaunches(s, launches);
  if (mode === "zostaff") {
    s.zPlan = buildZostaffPlan(
      s.startUsd,
      s.solUsd,
      launches.map((l) => l.symbol).filter(Boolean),
    );
    pushTape(s, {
      t: s.simT,
      kind: "note",
      symbol: "DESK",
      text: `Zostaff from scratch $${s.startUsd.toFixed(0)} · published 1 SOL → 80 SOL · live SOL snapshot`,
      tone: "warn",
    });
  } else if (mode === "live") {
    pushTape(s, {
      t: s.simT,
      kind: "note",
      symbol: "DESK",
      text: `live paper · Zostaff method from $${s.startUsd.toFixed(0)} · 0.1 SOL cap · 50% stop · 1% fee + Jito + curve slip · marks follow live mcap`,
      tone: "mute",
    });
  } else if (mode === "watch") {
    pushTape(s, {
      t: s.simT,
      kind: "note",
      symbol: "DESK",
      text: `watch · same Zostaff method, faster hunter on the live queue · fees still apply`,
      tone: "mute",
    });
  } else if (mode === "ict") {
    pushTape(s, {
      t: s.simT,
      kind: "note",
      symbol: "ICT",
      text: `ICT ${ictFilter} ${s.ictStyle === "cisd" ? "CISD 5m+15m A+" : s.ictStyle} ${s.ictStyle === "cisd" ? "5m+15m" : s.ictUse5m === false ? "15m" : "15m+5m"} from $${s.startUsd.toFixed(0)} · ${s.ictLev}x iso liq ${(ictLiqPct(s.ictLev) * 100).toFixed(1)}% · ${(s.ictRiskPct * 100).toFixed(0)}% 1R · ¾@${ICT_PARTIAL_R}R trail 5R${s.ictStyle === "cisd" ? " · no Silver · no Playback" : ""}`,
      tone: "mute",
    });
  }
  return s;
}

export function totalSol(s: EngineState): number {
  return s.equityUsd / Math.max(1e-6, s.solUsd);
}
