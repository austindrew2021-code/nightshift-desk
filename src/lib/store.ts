import { create } from "zustand";
import { DEFAULT_START_USD, type DeskMode, type MarketSnapshot } from "@/lib/engine/types";
import {
  applyMarket,
  clampStart,
  createEngine,
  ingestLaunches,
  resetEngine,
  tick,
  type EngineState,
} from "@/lib/engine/session";
import { buildZostaffPlan } from "@/lib/engine/zostaff";

const START_KEY = "nightshift.startUsd";

function writeSavedStart(n: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(START_KEY, String(n));
  } catch {
    /* ignore quota */
  }
}

interface DeskStore {
  engine: EngineState;
  market: MarketSnapshot | null;
  marketError: string | null;
  loadingMarket: boolean;
  grokBusy: boolean;
  grokNote: string | null;
  installedHint: boolean;
  hydrateMarket: (m: MarketSnapshot) => void;
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
      const engine = s.engine;
      applyMarket(engine, m);
      ingestLaunches(engine, m.launches);
      if (engine.mode === "zostaff" && engine.tickN < 4) {
        engine.zPlan = buildZostaffPlan(
          engine.startUsd,
          engine.solUsd,
          m.launches.map((l) => l.symbol).filter(Boolean),
        );
        engine.zCursor = 0;
        engine.zDone = false;
      }
      return { market: m, engine: { ...engine }, loadingMarket: false, marketError: null };
    }),
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
      return { engine };
    }),
  pause: () =>
    set((s) => ({ engine: { ...s.engine, running: false } })),
  setSpeed: (n) =>
    set((s) => ({ engine: { ...s.engine, speed: n } })),
  setMode: (m) => {
    const sol = get().market?.solUsd ?? get().engine.solUsd;
    const start = get().engine.startUsd;
    const launches = get().market?.launches ?? [];
    const engine = resetEngine(m, sol, start, launches);
    set({ engine, grokNote: null });
  },
  setStartUsd: (n) => {
    const start = clampStart(n);
    writeSavedStart(start);
    const sol = get().market?.solUsd ?? get().engine.solUsd;
    const mode = get().engine.mode;
    const launches = get().market?.launches ?? [];
    const engine = resetEngine(mode, sol, start, launches);
    set({ engine, grokNote: null });
  },
  step: () =>
    set((s) => ({ engine: { ...tick(s.engine, s.market) } })),
  reset: (mode) => {
    const m = mode ?? get().engine.mode;
    const sol = get().market?.solUsd ?? get().engine.solUsd;
    const start = get().engine.startUsd;
    const launches = get().market?.launches ?? [];
    const engine = resetEngine(m, sol, start, launches);
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
}));
