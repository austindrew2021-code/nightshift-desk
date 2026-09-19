import { create } from "zustand";
import { DEFAULT_START_USD, type DeskMode, type IctStyle, type MarketSnapshot } from "@/lib/engine/types";
import {
  applyMarket,
  applyQuotes,
  clampStart,
  createEngine,
  ingestIct,
  markIct,
  ingestLaunches,
  resetEngine,
  tick,
  type EngineState,
} from "@/lib/engine/session";
import { buildZostaffPlan } from "@/lib/engine/zostaff";
import type { IctBook } from "@/lib/engine/universe";
import { clearEngineSave, saveEngine, writeSavedStart } from "@/lib/persist";
import { applyLiveLast } from "@/lib/market/kucoin-hot";
import { cloudIsFresh } from "@/lib/cloud-live";

interface DeskStore {
  engine: EngineState;
  market: MarketSnapshot | null;
  marketError: string | null;
  loadingMarket: boolean;
  grokBusy: boolean;
  grokNote: string | null;
  installedHint: boolean;
  cloudAt: number;
  hydrateMarket: (m: MarketSnapshot) => void;
  hydrateQuotes: (q: Record<string, number>) => void;
  hydrateBooks: (books: IctBook[]) => void;
  hydrateLast: (px: Record<string, number>) => void;
  setIctFilter: (id: string) => void;
  setIctStyle: (id: IctStyle) => void;
  setIctUse5m: (on: boolean) => void;
  setIctRiskPct: (n: number) => void;
  setIctLev: (n: number) => void;
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
  applyCloud: (engine: EngineState, t: number) => void;
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
  cloudAt: 0,
  hydrateMarket: (m) =>
    set((s) => {
      const books = m.books?.length ? m.books : s.market?.books ?? [];
      const merged = { ...m, books };
      const engine = s.engine;
      applyMarket(engine, merged);
      ingestLaunches(engine, merged.launches);
      if (engine.mode === "ict" && books.length && !cloudIsFresh(s.cloudAt)) ingestIct(engine, merged);
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
      if (engine.mode === "ict" && market) {
        if (!cloudIsFresh(get().cloudAt)) ingestIct(engine, market);
        markIct(engine, market);
      }
      return { market, engine: { ...engine } };
    }),
  hydrateLast: (px) =>
    set((s) => {
      if (!s.market?.books?.length) return {};
      const books = s.market.books.map((b) => {
        const last = px[b.id];
        if (!(last > 0)) return b;
        const next = {
          ...b,
          last,
          candles5: b.candles5?.slice(),
          candles15: b.candles15?.slice(),
          candles1h: b.candles1h?.slice(),
        };
        applyLiveLast(next, last);
        return next;
      });
      const market = { ...s.market, books };
      const engine = s.engine;
      if (engine.mode === "ict") markIct(engine, market);
      return { market, engine: { ...engine } };
    }),
  setIctFilter: (id) => {
    const engine = { ...get().engine, ictFilter: id };
    const market = get().market;
    if (market && engine.mode === "ict" && !cloudIsFresh(get().cloudAt)) ingestIct(engine, market);
    set({ engine });
    saveEngine(engine);
  },
  setIctStyle: (id) => {
    const engine = { ...get().engine, ictStyle: id };
    const market = get().market;
    if (market && engine.mode === "ict" && !cloudIsFresh(get().cloudAt)) ingestIct(engine, market);
    set({ engine });
    saveEngine(engine);
  },
  setIctUse5m: (on) => {
    const engine = { ...get().engine, ictUse5m: on };
    const market = get().market;
    if (market && engine.mode === "ict" && !cloudIsFresh(get().cloudAt)) ingestIct(engine, market);
    set({ engine });
    saveEngine(engine);
  },
  setIctRiskPct: (n) => {
    const engine = { ...get().engine, ictRiskPct: n };
    set({ engine });
    saveEngine(engine);
  },
  setIctLev: (n) => {
    const engine = { ...get().engine, ictLev: n };
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
    const prev = get().engine;
    const engine = resetEngine(m, sol, start, launches, prev.ictFilter);
    engine.ictStyle = prev.ictStyle;
    engine.ictUse5m = prev.ictUse5m !== false;
    engine.ictRiskPct = prev.ictRiskPct;
    engine.ictLev = prev.ictLev;
    if (market) applyMarket(engine, market);
    if (m === "ict" && market?.books?.length && !cloudIsFresh(get().cloudAt)) ingestIct(engine, market);
    set({ engine, grokNote: null });
    saveEngine(engine);
  },
  setStartUsd: (n) => {
    const start = clampStart(n);
    writeSavedStart(start);
    const market = get().market;
    const prev = get().engine;
    const sol = market?.solUsd ?? prev.solUsd;
    const mode = prev.mode;
    const launches = market?.launches ?? [];
    const engine = resetEngine(mode, sol, start, launches, prev.ictFilter);
    engine.ictStyle = prev.ictStyle;
    engine.ictUse5m = prev.ictUse5m !== false;
    engine.ictRiskPct = prev.ictRiskPct;
    engine.ictLev = prev.ictLev;
    if (market) applyMarket(engine, market);
    if (mode === "ict" && market?.books?.length && !cloudIsFresh(get().cloudAt)) ingestIct(engine, market);
    set({ engine, grokNote: null });
    saveEngine(engine);
  },
  step: () =>
    set((s) => {
      if (s.engine.mode === "ict" && cloudIsFresh(s.cloudAt)) {
        if (s.market && s.engine.open.some((p) => p.origin === "ict")) {
          markIct(s.engine, s.market);
        }
        return { engine: { ...s.engine, simT: Date.now() } };
      }
      return { engine: { ...tick(s.engine, s.market) } };
    }),
  reset: (mode) => {
    const m = mode ?? get().engine.mode;
    const market = get().market;
    const sol = market?.solUsd ?? get().engine.solUsd;
    const start = get().engine.startUsd;
    const launches = market?.launches ?? [];
    const prev = get().engine;
    const engine = resetEngine(m, sol, start, launches, prev.ictFilter);
    engine.ictStyle = m === "ict" ? "cisd" : prev.ictStyle;
    engine.ictUse5m = prev.ictUse5m !== false;
    engine.ictRiskPct = prev.ictRiskPct;
    engine.ictLev = prev.ictLev;
    if (market) applyMarket(engine, market);
    if (m === "ict" && market?.books?.length && !cloudIsFresh(get().cloudAt)) ingestIct(engine, market);
    clearEngineSave();
    saveEngine(engine);
    set({
      engine,
      grokNote: cloudIsFresh(get().cloudAt)
        ? "Phone is a viewer. CLOUD still holds the old book until the next worker tick (~2m). Leave it — don't keep tapping Reset."
        : null,
    });
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
  applyCloud: (engine, t) => {
    const cur = get().engine;
    const score = (e: EngineState) => {
      const c = (e.closed ?? []).filter((x) => x.origin === "ict");
      const o = (e.open ?? []).filter((p) => p.origin === "ict");
      return {
        n: c.length,
        last: Math.max(0, ...c.map((x) => x.closedAt || 0), ...o.map((p) => p.openedAt || 0)),
        bank: Number(e.bankedUsd) || 0,
      };
    };
    const L = score(cur);
    const C = score(engine);
    if (L.n > C.n || L.last > C.last + 30_000 || L.bank > C.bank + 0.5) {
      if (cloudIsFresh(t)) set({ cloudAt: t });
      return;
    }
    if (!cloudIsFresh(t)) return;
    const seen = new Set<string>();
    const closed = [];
    for (const c of [...(cur.closed ?? []), ...(engine.closed ?? [])]) {
      const k = `${c.id || ""}-${c.symbol}-${c.openedAt}-${c.reason}`;
      if (seen.has(k)) continue;
      seen.add(k);
      closed.push(c);
    }
    closed.sort((a, b) => b.closedAt - a.closedAt);
    const closedKeys = new Set(closed.filter((c) => c.origin === "ict").map((c) => `${c.symbol}-${c.openedAt}`));
    const open = (engine.open ?? []).filter((p) => !closedKeys.has(`${p.symbol}-${p.openedAt}`));
    set({
      engine: { ...engine, open, closed: closed.slice(0, 120), running: true, simT: Date.now() },
      cloudAt: t,
      grokNote: null,
    });
  },
  persistNow: () => saveEngine(get().engine),
}));
