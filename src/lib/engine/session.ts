import {
  AGENT_META,
  DAILY_LOSS_PCT,
  DEFAULT_START_USD,
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
import { nyParts, scanIct, scanSmt, scanSwingNative, simulateIct, styleAllows } from "./ict";
import { fillQuality, modelBuy, modelSell } from "./execution";
import type { IctBook } from "./universe";
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
  tickN: number;
  dayLoss: number;
  zPlan: ZostaffStep[];
  zCursor: number;
  zDone: boolean;
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
  };
}

function finite(n: number | undefined, d = 0): number {
  return Number.isFinite(n) ? (n as number) : d;
}

export function clampStart(n: number): number {
  const v = finite(n, DEFAULT_START_USD);
  return Math.min(1_000_000, Math.max(10, Math.round(v)));
}

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
    ictStyle: "all",
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
    peakUsd: Math.max(finite(p.peakUsd, mark), mark),
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
    s.cashUsd = finite(s.cashUsd) + finite(p.sizeUsd) + finite(pnlUsd);
  }
  const pnlSol = finite(pnlUsd) / Math.max(1e-6, s.solUsd);
  const rMultiple = finite(pnlUsd) / Math.max(1e-6, finite(p.sizeUsd) * p.stopPct);
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
      note: p.note,
      origin: p.origin,
      stopUsd: p.stopUsd,
      targetUsd: p.targetUsd,
      quotedEntryUsd: p.quotedEntryUsd,
      quotedExitUsd: exitUsd,
      feeUsd,
      jitoUsd,
      slippagePct: slip,
    },
    ...s.closed,
  ].slice(0, 80);
  if (pnlUsd >= 0) s.stats.wins += 1;
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
    text: `${reason} ${p.symbol} ${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)} usd${cost}`,
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
    if (tr.pnlUsd >= 0) s.stats.wins += 1;
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

function markIct(s: EngineState, market: MarketSnapshot | null) {
  const books = market?.books ?? [];
  for (const p of s.open) {
    if (p.origin !== "ict") continue;
    const b = books.find((x) => x.symbol === p.symbol || x.id === p.symbol);
    const last = b?.last || b?.candles15[b.candles15.length - 1]?.c;
    if (!last) continue;
    const c = b?.candles15[b.candles15.length - 1];
    const hi = c ? Math.max(c.h, last) : last;
    const lo = c ? Math.min(c.l, last) : last;
    const stopPx = p.side === "long" ? p.entryUsd * (1 - p.stopPct) : p.entryUsd * (1 + p.stopPct);
    const tgtPx = p.side === "long" ? p.entryUsd * (1 + p.stopPct * p.targetR) : p.entryUsd * (1 - p.stopPct * p.targetR);
    if (p.side === "long" && lo <= stopPx) {
      s.open = s.open.filter((x) => x.id !== p.id);
      closePos(s, p, stopPx, "stop");
      continue;
    }
    if (p.side === "short" && hi >= stopPx) {
      s.open = s.open.filter((x) => x.id !== p.id);
      closePos(s, p, stopPx, "stop");
      continue;
    }
    if (p.side === "long" && hi >= tgtPx) {
      s.open = s.open.filter((x) => x.id !== p.id);
      closePos(s, p, tgtPx, "target");
      continue;
    }
    if (p.side === "short" && lo <= tgtPx) {
      s.open = s.open.filter((x) => x.id !== p.id);
      closePos(s, p, tgtPx, "target");
      continue;
    }
    s.open = s.open.map((x) => (x.id === p.id ? revalue(s, x, last) : x));
  }
  s.stats.openCount = s.open.length;
}

function reasonLabel(r: ClosedTrade["reason"]) {
  return r;
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
  const filtered = s.ictFilter === "ALL" ? books : books.filter((b) => b.id === s.ictFilter);
  const btc = books.find((b) => b.id === "BTC");
  const eth = books.find((b) => b.id === "ETH");
  const risk = Math.max(1, s.startUsd * 0.01);
  const liveFrom = (s.wallStarted || Date.now()) - 20 * 60_000;
  let added = 0;
  const fresh: ClosedTrade[] = [];
  for (const b of filtered) {
    if (b.candles15.length < 40) continue;
    const lastT = b.candles15[b.candles15.length - 1]?.t ?? 0;
    const corr = b.id === "BTC" ? eth : btc;
    const extra =
      corr && corr.id !== b.id ? scanSmt(b.candles15, corr.candles15, corr.symbol) : [];
    const raw = [...scanIct(b.candles15), ...extra];
    if ((s.ictStyle === "all" || s.ictStyle === "scalp") && b.candles5 && b.candles5.length >= 48) {
      for (const sig of scanIct(b.candles5, { skipSwing: true })) {
        if (sig.setup === "silver" || sig.setup === "scalp" || sig.setup === "sweep") {
          raw.push({ ...sig, note: `${sig.note} · 5m` });
        }
      }
    }
    if ((s.ictStyle === "all" || s.ictStyle === "swing") && b.candles1h && b.candles1h.length >= 24) {
      for (const sig of scanSwingNative(b.candles1h)) raw.push({ ...sig, note: `${sig.note} · 1H` });
    }
    const sigs = raw.filter((x) => styleAllows(s.ictStyle, x.setup));
    const sim = simulateIct(b.candles15, sigs, risk, b.symbol, b.name).map((t) => ({
      ...t,
      origin: "ict" as const,
      pnlSol: t.pnlUsd / Math.max(1e-6, s.solUsd),
    }));
    for (const t of sim) {
      const lastT = b.candles15[b.candles15.length - 1]?.t ?? 0;
      const stillOpen = t.reason === "time" && t.closedAt >= lastT - 60_000;
      const today = nyParts(Date.now()).day === nyParts(t.openedAt).day;
      if (t.openedAt < liveFrom && !(stillOpen && today)) continue;
      const key = `${t.symbol}-${t.setup}-${t.openedAt}`;
      if (s.ictSeen.includes(key)) continue;
      s.ictSeen = [...s.ictSeen, key];
      if (stillOpen) {
        if (s.open.some((p) => p.id === t.id) || s.open.length >= MAX_OPEN) continue;
        const stopDist = Math.abs(t.entryUsd - t.stop);
        const stopPct = stopDist / Math.max(1e-9, t.entryUsd);
        const sizeUsd = risk / Math.max(1e-6, stopPct);
        s.cashUsd -= sizeUsd;
        const mark = b.last || t.entryUsd;
        const dir = t.side === "short" ? -1 : 1;
        const pnlUsd = ((mark - t.entryUsd) / Math.max(1e-9, t.entryUsd)) * sizeUsd * dir;
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
            targetR: Math.abs(t.target - t.entryUsd) / Math.max(1e-9, stopDist),
            markUsd: mark,
            pnlSol: pnlUsd / Math.max(1e-6, s.solUsd),
            pnlUsd,
            peakUsd: mark,
            agent: "timing",
            note: t.note,
            origin: "ict",
            stopUsd: t.stop,
            targetUsd: t.target,
          },
        ];
        s.stats.taken += 1;
        s.stats.openCount = s.open.length;
        pushTape(s, {
          t: s.simT,
          kind: "open",
          agent: "timing",
          symbol: t.symbol,
          text: `live ${t.side} ${t.symbol} @ ${t.entryUsd.toFixed(t.entryUsd < 2 ? 5 : 2)} · ${t.note}`,
          tone: "up",
        });
        added += 1;
        continue;
      }
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
  else if (s.mode === "ict") tickIct(s, market);
  else tickMeme(s, market);

  const openPnl = s.open.reduce((acc, p) => acc + finite(p.pnlUsd), 0);
  s.cashUsd = finite(s.cashUsd, s.startUsd);
  s.equityUsd = finite(s.cashUsd + openPnl, s.startUsd);
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
      text: `ICT ${ictFilter} ${s.ictStyle} from $${s.startUsd.toFixed(0)} · live fills only · sweep/scalp/swing + 5m/1H`,
      tone: "mute",
    });
  }
  return s;
}

export function totalSol(s: EngineState): number {
  return s.equityUsd / Math.max(1e-6, s.solUsd);
}
