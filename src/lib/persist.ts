import {
  createEngine,
  type EngineState,
} from "@/lib/engine/session";
import type { DeskMode, TapeEvent } from "@/lib/engine/types";

const KEY = "nightshift.engine.v3";
const START_KEY = "nightshift.startUsd";
const MODES: DeskMode[] = ["watch", "live", "ict", "zostaff"];

function finite(n: unknown, d = 0): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : d;
}

export function writeSavedStart(n: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(START_KEY, String(n));
  } catch {
    /* quota */
  }
}

export function saveEngine(engine: EngineState) {
  if (typeof window === "undefined") return;
  try {
    const slim: EngineState = {
      ...engine,
      liveQueue: [],
      heatmap: engine.heatmap.slice(0, 192),
      tape: engine.tape.slice(0, 40),
      closed: engine.closed.slice(0, 50),
      equity: engine.equity.slice(-120),
      ictTrades: engine.ictTrades.slice(0, 80),
      ictSeen: engine.ictSeen.slice(-400),
      seenMints: engine.seenMints.slice(-400),
      zPlan: engine.zPlan,
    };
    window.localStorage.setItem(KEY, JSON.stringify({ t: Date.now(), engine: slim }));
    writeSavedStart(engine.startUsd);
  } catch {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
}

export function clearEngineSave() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function loadEngine(): EngineState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t?: number; engine?: EngineState };
    const e = parsed.engine;
    if (!e || !MODES.includes(e.mode)) return null;
    const base = createEngine(finite(e.solUsd, 100), finite(e.startUsd, 1000));
    const restored: EngineState = {
      ...base,
      ...e,
      mode: e.mode,
      running: false,
      startUsd: finite(e.startUsd, base.startUsd),
      cashUsd: finite(e.cashUsd, base.startUsd),
      equityUsd: finite(e.equityUsd, base.startUsd),
      peakUsd: finite(e.peakUsd, base.startUsd),
      bankedUsd: finite((e as EngineState).bankedUsd),
      solUsd: finite(e.solUsd, 100),
      liveQueue: [],
      heatmap: Array.isArray(e.heatmap) && e.heatmap.length === 192 ? e.heatmap : base.heatmap,
      open: Array.isArray(e.open) ? e.open : [],
      closed: Array.isArray(e.closed) ? e.closed : [],
      tape: Array.isArray(e.tape) ? e.tape : [],
      equity: Array.isArray(e.equity) && e.equity.length ? e.equity : [{ t: Date.now(), v: finite(e.equityUsd, base.startUsd) }],
      agents: Array.isArray(e.agents) && e.agents.length === 5 ? e.agents : base.agents,
      stats: { ...base.stats, ...(e.stats ?? {}) },
      gauges: { ...base.gauges, ...(e.gauges ?? {}) },
      quotes: e.quotes && typeof e.quotes === "object" ? e.quotes : {},
      seenMints: Array.isArray(e.seenMints) ? e.seenMints : [],
      ictTrades: Array.isArray(e.ictTrades) ? e.ictTrades : [],
      ictSeen: Array.isArray(e.ictSeen) ? e.ictSeen : [],
      ictFilter: typeof e.ictFilter === "string" ? e.ictFilter : "ALL",
      ictStyle: e.ictStyle === "sweep" || e.ictStyle === "scalp" || e.ictStyle === "swing" ? e.ictStyle : "all",
      zPlan: Array.isArray(e.zPlan) ? e.zPlan : [],
      zCursor: finite(e.zCursor),
      zDone: Boolean(e.zDone),
      tickN: finite(e.tickN),
      ictCursor: finite(e.ictCursor),
      dayLoss: finite(e.dayLoss),
      wallStarted: finite(e.wallStarted, Date.now()),
      simT: Date.now(),
    };
    const note: TapeEvent = {
      id: `t-resume-${Date.now()}`,
      t: Date.now(),
      kind: "note",
      symbol: "DESK",
      text: "restored after close · book kept · ticks were paused while the phone killed the page",
      tone: "warn",
    };
    if (!restored.tape[0]?.text?.startsWith("restored after close")) {
      restored.tape = [note, ...restored.tape].slice(0, 80);
    }
    return restored;
  } catch {
    return null;
  }
}
