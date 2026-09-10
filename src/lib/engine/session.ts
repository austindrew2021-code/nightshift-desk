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
import { scanIct, simulateIct } from "./ict";
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
  };
}

function finite(n: number, d = 0): number {
  return Number.isFinite(n) ? n : d;
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
  const capSol = MAX_SOL_PER_TRADE * (s.startUsd / DEFAULT_START_USD);
  const capUsd = capSol * Math.max(1, s.solUsd);
  const base = finite(s.equityUsd, s.startUsd) * MAX_POS_PCT * Math.min(1, Math.max(0.35, sc));
  const usd = Math.max(
    1,
    Math.min(base, room * 0.3, finite(s.cashUsd, s.startUsd) * 0.2, capUsd),
  );
  return finite(usd, 1);
}

function revalue(s: EngineState, p: Position, next: number): Position {
  const entry = Math.max(1e-9, finite(p.entryUsd, 1));
  const size = finite(p.sizeUsd, 1);
  const mark = Math.max(0, finite(next, p.markUsd));
  const pnlUsd = ((mark - entry) / entry) * size;
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
  const pnlUsd = ((exitUsd - p.entryUsd) / Math.max(1e-9, finite(p.entryUsd, 1))) * finite(p.sizeUsd);
  const pnlSol = finite(pnlUsd) / Math.max(1e-6, s.solUsd);
  const rMultiple = finite(pnlUsd) / Math.max(1e-6, finite(p.sizeUsd) * p.stopPct);
  s.cashUsd = finite(s.cashUsd) + finite(p.sizeUsd) + finite(pnlUsd);
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
      exitUsd,
      sizeSol: p.sizeSol,
      pnlSol,
      pnlUsd,
      rMultiple,
      reason,
      score: 0.7,
      note: p.note,
      origin: p.origin,
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
  pushTape(s, {
    t: s.simT,
    kind,
    agent: p.agent,
    symbol: p.symbol,
    text: `${reason} ${p.symbol} ${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)} usd`,
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
    const timeHit = s.simT - p.openedAt > MAX_HOLD_MS;
    if (stopHit || targetHit || trailHit || timeHit) {
      const reason = stopHit ? "stop" : targetHit ? "target" : trailHit ? "trail" : "time";
      closePos(s, p, p.markUsd, reason);
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
  if (usd < 1 || usd > s.cashUsd || !Number.isFinite(usd)) return;
  s.cashUsd -= usd;
  const mcap = Math.max(50, finite(token.launch.usdMcap, 400));
  const pos: Position = {
    id: nid("p"),
    symbol: token.launch.symbol,
    name: token.launch.name,
    mint: token.launch.mint,
    setup: "curve",
    side: "long",
    openedAt: s.simT,
    entryUsd: mcap,
    sizeSol: usd / Math.max(1e-6, s.solUsd),
    sizeUsd: usd,
    stopPct: STOP_PCT,
    targetR: 2,
    markUsd: mcap,
    pnlSol: 0,
    pnlUsd: 0,
    peakUsd: mcap,
    agent: "checker",
    note: `live mcap ${mcap.toFixed(0)} · score ${finite(token.score).toFixed(2)} · ${token.launch.mint.slice(0, 6)}…`,
    origin,
  };
  s.open = [...s.open, pos];
  s.stats.taken += 1;
  s.stats.openCount = s.open.length;
  s.quotes[token.launch.mint] = mcap;
  s.gauges.follow = s.stats.scanned ? s.stats.passed / Math.max(1, s.stats.scanned) : 0;
  s.gauges.fill = 0.62 + token.curveHealth * 0.3;
  s.gauges.decay = Math.min(0.9, token.curvePct / 100 + 0.2);
  bumpSpark(s, "checker", 0);
  pushTape(s, {
    t: s.simT,
    kind: "open",
    agent: "checker",
    symbol: token.launch.symbol,
    text: `opened ${pos.sizeSol.toFixed(3)} sol in ${token.launch.symbol} @ $${mcap.toFixed(0)} mcap  score ${token.score.toFixed(2)}`,
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
    if (s.tickN % 2 === 0) {
      pushTape(s, {
        t: s.simT,
        kind: "skip",
        agent: "hunter",
        symbol: token.launch.symbol,
        text: `skip ${token.launch.symbol} · ${token.skipReason}`,
        tone: "mute",
      });
    }
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
  if (!s.ictTrades.length && market && market.candles15.length > 40) {
    const risk = Math.max(1, s.startUsd * 0.01);
    const sigs = scanIct(market.candles15);
    s.ictTrades = simulateIct(market.candles15, sigs, risk).map((t) => ({
      ...t,
      origin: "ict" as const,
      pnlSol: t.pnlUsd / Math.max(1e-6, s.solUsd),
    }));
    pushTape(s, {
      t: s.simT,
      kind: "note",
      symbol: "SOL",
      text: `ICT replay · ${s.ictTrades.length} mechanical signals on last ${market.candles15.length} SOL 15m candles · risk $${risk.toFixed(0)} / fill (1% of start)`,
      tone: "mute",
    });
  }
  if (s.ictCursor >= s.ictTrades.length) {
    s.running = false;
    setAgent(s, "timing", { status: "replay complete", busy: false });
    return;
  }
  const tr = s.ictTrades[s.ictCursor]!;
  s.ictCursor += 1;
  s.stats.scanned += 12;
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
    symbol: "SOL",
    text: `${tr.side} SOL @ ${tr.entryUsd.toFixed(2)}  ${tr.note}`,
    tone: "mute",
  });
  pushTape(s, {
    t: tr.closedAt,
    kind: tr.reason === "stop" ? "stop" : "close",
    agent: "timing",
    symbol: "SOL",
    text: `${tr.reason} ${tr.side}  ${tr.pnlUsd >= 0 ? "+" : ""}${tr.pnlUsd.toFixed(2)} usd  ${tr.rMultiple.toFixed(2)}R  ${tr.setup}`,
    tone: tr.pnlUsd >= 0 ? "up" : "down",
  });
  s.closed = [tr, ...s.closed];
  s.gauges.follow = s.stats.taken ? s.stats.wins / s.stats.taken : 0;
  s.gauges.fill = 0.8;
  s.gauges.decay = 0.35;
  setAgent(s, "timing", {
    status: `${tr.setup} ${tr.side} ${tr.rMultiple.toFixed(2)}R`,
    lastScore: Math.max(0, Math.min(1, (tr.rMultiple + 1) / 3)),
    busy: true,
  });
}

function nextUnseen(s: EngineState): Launch | null {
  for (const l of s.liveQueue) {
    if (!s.seenMints.includes(l.mint)) return l;
  }
  return null;
}

function tickMeme(s: EngineState, market: MarketSnapshot | null) {
  markLive(s);
  const timing = regimeScore(market);
  setAgent(s, "timing", { status: `regime ${timing.toFixed(2)}`, lastScore: timing, busy: true });

  const live = s.mode === "live";
  const burst = live ? (s.tickN % 6 === 0 ? 1 : 0) : 2;
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

export function ingestLaunches(s: EngineState, launches: Launch[]) {
  s.liveQueue = launches;
  for (const l of launches) {
    if (l.usdMcap > 0) s.quotes[l.mint] = l.usdMcap;
  }
}

export function applyMarket(s: EngineState, m: MarketSnapshot) {
  if (s.mode !== "zostaff" || s.tickN < 4) {
    s.solUsd = m.solUsd || s.solUsd;
  }
  ingestLaunches(s, m.launches);
  if (s.mode === "live" || s.mode === "watch") markLive(s);
}

export function tick(s: EngineState, market: MarketSnapshot | null): EngineState {
  if (!s.running) return s;
  s.tickN += 1;
  if (s.mode === "live") {
    s.simT = Date.now();
  } else {
    const stepMs = 12_000 * Math.max(1, 8 / s.speed);
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

export function resetEngine(mode: DeskMode, solUsd: number, startUsd: number, launches: Launch[] = []): EngineState {
  const s = createEngine(solUsd, startUsd);
  s.mode = mode;
  s.running = true;
  s.simT = Date.now();
  s.wallStarted = Date.now();
  s.equity = [{ t: s.simT, v: s.startUsd }];
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
      text: `live paper from $${s.startUsd.toFixed(0)} · marks follow live pump.fun mcap · no simulated dumps`,
      tone: "mute",
    });
  } else if (mode === "watch") {
    pushTape(s, {
      t: s.simT,
      kind: "note",
      symbol: "DESK",
      text: `watch from $${s.startUsd.toFixed(0)} · same live mints, faster hunter · PnL is live mcap`,
      tone: "mute",
    });
  }
  return s;
}

export function totalSol(s: EngineState): number {
  return s.equityUsd / Math.max(1e-6, s.solUsd);
}
