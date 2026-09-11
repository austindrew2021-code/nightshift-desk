import { create } from "zustand";
import { DEFAULT_START_USD, type DeskMode, type IctStyle, type MarketSnapshot } from "@/lib/engine/types";
import {
  applyMarket,
  applyQuotes,
  clampStart,
  createEngine,
  ingestIct,
  ingestLaunches,
  resetEngine,
  tick,
  type EngineState,
} from "@/lib/engine/session";
import { buildZostaffPlan } from "@/lib/engine/zostaff";
import type { IctBook } from "@/lib/engine/universe";
import { clearEngineSave, saveEngine, writeSavedStart } from "@/lib/persist";

interface DeskStore {
  engine: EngineState;
  market: MarketSnapshot | null;
  marketError: string | null;
  loadingMarket: boolean;
  grokBusy: boolean;
  grokNote: string | null;
  installedHint: boolean;
  hydrateMarket: (m: MarketSnapshot) => void;
  hydrateQuotes: (q: Record<string, number>) => void;
  hydrateBooks: (books: IctBook[]) => void;
  setIctFilter: (id: string) => void;
  setIctStyle: (id: IctStyle) => void;
  setMarketError: (e: string | null) => void;
  setLoading: (v: boolean) => void;
  play: () => void;
  pause: () => void;
  setSpeed: (n: number) => void;
  setMode: (m: DeskMode) => void;
  setStartUsd: (n: number) => void;
  step: () => void;
  reset: (mode?: DeskMode) => void;
  setGrok: (busy: boolean, note?: string | null) => void;
  bumpGrokCalls: () => void;
  dismissInstall: () => void;
  restoreSession: (engine: EngineState) => void;
  persistNow: () => void;
}

function bootEngine(): EngineState {
  return createEngine(100, DEFAULT_START_USD);
}

export const useDesk = create<DeskStore>((set, get) => ({
  engine: bootEngine(),
  market: null,
  marketError: null,
  loadingMarket: true,
  grokBusy: false,
  grokNote: null,
  installedHint: true,
  hydrateMarket: (m) =>
    set((s) => {
      const books = m.books?.length ? m.books : s.market?.books ?? [];
      const merged = { ...m, books };
      const engine = s.engine;
      applyMarket(engine, merged);
      ingestLaunches(engine, merged.launches);
      if (engine.mode === "ict" && books.length) ingestIct(engine, merged);
      if (engine.mode === "zostaff" && engine.tickN < 4 && engine.zPlan.length === 0) {
        engine.zPlan = buildZostaffPlan(
          engine.startUsd,
          engine.solUsd,
          merged.launches.map((l) => l.symbol).filter(Boolean),
        );
        engine.zCursor = 0;
        engine.zDone = false;
      }
      return { market: merged, engine: { ...engine }, loadingMarket: false, marketError: null };
    }),
  hydrateQuotes: (q) =>
    set((s) => {
      const engine = s.engine;
      applyQuotes(engine, q);
      return { engine: { ...engine } };
    }),
  hydrateBooks: (books) =>
    set((s) => {
      const market = s.market ? { ...s.market, books } : s.market;
      const engine = s.engine;
      if (engine.mode === "ict" && market) ingestIct(engine, market);
      return { market, engine: { ...engine } };
    }),
  setIctFilter: (id) => {
    const market = get().market;
    const sol = market?.solUsd ?? get().engine.solUsd;
    const start = get().engine.startUsd;
    const launches = market?.launches ?? [];
    const engine = resetEngine("ict", sol, start, launches, id);
    engine.mode = "ict";
    engine.ictStyle = get().engine.ictStyle;
    if (market) {
      if (market.books?.length) ingestIct(engine, market);
      applyMarket(engine, market);
    }
    set({ engine, grokNote: null });
    saveEngine(engine);
  },
  setIctStyle: (id) => {
    const engine = { ...get().engine, ictStyle: id };
    const market = get().market;
    if (market && engine.mode === "ict") ingestIct(engine, market);
    set({ engine });
    saveEngine(engine);
  },
  setMarketError: (e) => set({ marketError: e, loadingMarket: false }),
  setLoading: (v) => set({ loadingMarket: v }),
  play: () =>
    set((s) => {
      const now = Date.now();
      const engine = { ...s.engine, running: true };
      if (!engine.wallStarted) {
        engine.wallStarted = now;
        engine.simT = now;
        engine.equity = [{ t: now, v: engine.equityUsd }];
      }
      if (engine.mode === "live" && s.market) applyMarket(engine, s.market);
      return { engine };
    }),
  pause: () =>
    set((s) => ({ engine: { ...s.engine, running: false } })),
  setSpeed: (n) =>
    set((s) => ({ engine: { ...s.engine, speed: n } })),
  setMode: (m) => {
    const market = get().market;
    const sol = market?.solUsd ?? get().engine.solUsd;
    const start = get().engine.startUsd;
    const launches = market?.launches ?? [];
    const engine = resetEngine(m, sol, start, launches, get().engine.ictFilter);
    if (market) applyMarket(engine, market);
    if (m === "ict" && market?.books?.length) ingestIct(engine, market);
    set({ engine, grokNote: null });
    saveEngine(engine);
  },
  setStartUsd: (n) => {
    const start = clampStart(n);
    writeSavedStart(start);
    const market = get().market;
    const sol = market?.solUsd ?? get().engine.solUsd;
    const mode = get().engine.mode;
    const launches = market?.launches ?? [];
    const engine = resetEngine(mode, sol, start, launches, get().engine.ictFilter);
    if (market) applyMarket(engine, market);
    if (mode === "ict" && market?.books?.length) ingestIct(engine, market);
    set({ engine, grokNote: null });
    saveEngine(engine);
  },
  step: () =>
    set((s) => ({ engine: { ...tick(s.engine, s.market) } })),
  reset: (mode) => {
    const m = mode ?? get().engine.mode;
    const market = get().market;
    const sol = market?.solUsd ?? get().engine.solUsd;
    const start = get().engine.startUsd;
    const launches = market?.launches ?? [];
    const engine = resetEngine(m, sol, start, launches, get().engine.ictFilter);
    if (market) applyMarket(engine, market);
    if (m === "ict" && market?.books?.length) ingestIct(engine, market);
    clearEngineSave();
    saveEngine(engine);
    set({ engine });
  },
  setGrok: (busy, note) => set({ grokBusy: busy, grokNote: note ?? null }),
  bumpGrokCalls: () =>
    set((s) => ({
      engine: {
        ...s.engine,
        stats: { ...s.engine.stats, grokCalls: s.engine.stats.grokCalls + 1 },
      },
    })),
  dismissInstall: () => set({ installedHint: false }),
  restoreSession: (engine) => {
    if (engine.mode === "ict") {
      const closedPnl = (engine.closed ?? [])
        .filter((t) => t.origin === "ict")
        .reduce((acc, t) => acc + (Number.isFinite(t.pnlUsd) ? t.pnlUsd : 0), 0);
      engine = { ...engine, cashUsd: engine.startUsd + closedPnl };
    }
    set({ engine, grokNote: null });
  },
  persistNow: () => saveEngine(get().engine),
}));
