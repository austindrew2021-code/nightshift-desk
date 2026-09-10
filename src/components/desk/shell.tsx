import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Pause, Play, RotateCcw } from "lucide-react";
import {
  START_PRESETS,
  type DeskMode,
  type DeskStats,
  type MarketSnapshot,
} from "@/lib/engine/types";
import { fmtClock, fmtInt, fmtPct, fmtSol, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDesk } from "@/lib/store";

const NAV = [
  { to: "/", label: "Desk" },
  { to: "/market", label: "Market" },
  { to: "/playbook", label: "Playbook" },
  { to: "/log", label: "Log" },
] as const;

const MODES: { id: DeskMode; label: string }[] = [
  { id: "watch", label: "Watch" },
  { id: "live", label: "Live paper" },
  { id: "ict", label: "ICT · SOL" },
  { id: "zostaff", label: "Zostaff run" },
];

export function AppNav() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="flex flex-wrap items-center gap-1">
      {NAV.map((n) => {
        const on = path === n.to;
        return (
          <Link
            key={n.to}
            to={n.to as "/"}
            className={cn(
              "h-11 shrink-0 rounded-md px-3 font-mono text-[11px] tracking-[0.16em] uppercase inline-flex items-center",
              "transition-[background-color,color] duration-150",
              on ? "bg-phosphor text-phosphor-ink" : "text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Frame({ children }: { children: ReactNode }) {
  const equity = useDesk((s) => s.engine.equityUsd);
  const running = useDesk((s) => s.engine.running);
  return (
    <div className="desk-shell min-h-dvh pb-8">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Link to="/" className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-md bg-phosphor text-phosphor-ink font-mono text-sm font-semibold">
            N
          </span>
          <span className="font-sans text-sm text-fg">NIGHTSHIFT</span>
        </Link>
        <AppNav />
        <p className="ml-auto font-mono text-[11px] tabular text-muted">
          {running ? "live" : "paused"} · {fmtUsd(equity)}
        </p>
      </header>
      {children}
    </div>
  );
}

export function StartCapital({
  startUsd,
  onApply,
}: {
  startUsd: number;
  onApply: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(startUsd));
  useEffect(() => {
    setDraft(String(startUsd));
  }, [startUsd]);

  function apply(n: number) {
    if (!Number.isFinite(n)) return;
    onApply(n);
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <p className="font-mono text-[10px] tracking-[0.16em] text-subtle uppercase">start</p>
      {START_PRESETS.map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => apply(n)}
          className={cn(
            "h-11 min-w-11 rounded-md px-2.5 font-mono text-[11px] tabular transition-[background-color,color] duration-150",
            startUsd === n ? "bg-phosphor text-phosphor-ink" : "text-muted hover:bg-surface-2 hover:text-fg",
          )}
        >
          {n >= 1000 ? `$${n / 1000}k` : `$${n}`}
        </button>
      ))}
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          apply(Number(draft.replace(/[$,]/g, "")));
        }}
      >
        <label className="sr-only" htmlFor="start-usd">
          Starting balance USD
        </label>
        <span className="font-mono text-[11px] text-subtle">$</span>
        <input
          id="start-usd"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          suppressHydrationWarning
          className="h-11 w-24 rounded-md bg-surface-2 px-2 font-mono text-sm tabular text-fg shadow-[0_0_0_1px_rgba(61,255,138,0.16)] outline-none focus:shadow-[0_0_0_1px_rgba(61,255,138,0.5)]"
        />
        <Button size="sm" variant="outline" type="submit">
          Apply
        </Button>
      </form>
    </div>
  );
}

export function TopBar({
  equityUsd,
  startUsd,
  solUsd,
  stats,
  simT,
  running,
  speed,
  mode,
  onPlay,
  onPause,
  onReset,
  onSpeed,
  onMode,
  onStart,
  market,
}: {
  equityUsd: number;
  startUsd: number;
  solUsd: number;
  stats: DeskStats;
  simT: number;
  running: boolean;
  speed: number;
  mode: DeskMode;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  onSpeed: (n: number) => void;
  onMode: (m: DeskMode) => void;
  onStart: (n: number) => void;
  market: MarketSnapshot | null;
}) {
  const pnl = equityUsd - startUsd;
  const sol = equityUsd / Math.max(1e-6, solUsd);
  return (
    <header className="flex flex-col gap-3 border-b border-line px-3 py-3 md:px-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-md bg-phosphor text-phosphor-ink font-mono text-sm font-semibold">
            N
          </span>
          <div>
            <p className="font-sans text-sm font-medium tracking-tight text-fg">NIGHTSHIFT</p>
            <p className="font-mono text-[10px] tracking-[0.16em] text-subtle uppercase">
              five agents · paper desk
            </p>
          </div>
        </div>
        <div className="hidden md:block">
          <AppNav />
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-4 font-mono text-[11px] tabular">
          <div className="text-right">
            <p className="tracking-[0.16em] text-subtle uppercase">balance</p>
            <p className="text-sm text-fg">{fmtSol(sol, 2)}</p>
          </div>
          <div className="text-right">
            <p className="tracking-[0.16em] text-subtle uppercase">session</p>
            <p className={cn("text-sm", pnl >= 0 ? "text-phosphor" : "text-loss")}>{fmtPct(pnl / startUsd)}</p>
          </div>
          <div className="text-right">
            <p className="tracking-[0.16em] text-subtle uppercase">fills</p>
            <p className="text-sm text-fg">
              {stats.taken}/{stats.wins + stats.losses || 0}
            </p>
          </div>
          <div className="text-right">
            <p className="tracking-[0.16em] text-subtle uppercase">scanned</p>
            <p className="text-sm text-fg">{fmtInt(stats.scanned)}</p>
          </div>
          <div className="text-right">
            <p className="tracking-[0.16em] text-subtle uppercase">clock</p>
            <p className="text-sm text-fg">{fmtClock(simT)}</p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={running ? "outline" : "primary"} onClick={running ? onPause : onPlay}>
          {running ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {running ? "Pause" : "Run backtest"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onReset}>
          <RotateCcw className="size-3.5" />
          Reset
        </Button>
        <div className="flex rounded-md shadow-[0_0_0_1px_rgba(61,255,138,0.12)]">
          {[1, 4, 8, 16].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onSpeed(n)}
              className={cn(
                "h-11 min-w-11 px-2 font-mono text-[11px] transition-[background-color,color] duration-150",
                speed === n ? "bg-phosphor text-phosphor-ink" : "text-muted hover:text-fg",
              )}
            >
              {n}x
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onMode(m.id)}
              className={cn(
                "h-11 rounded-md px-2.5 font-mono text-[10px] tracking-[0.14em] uppercase transition-[background-color,color] duration-150",
                mode === m.id ? "bg-surface-2 text-phosphor" : "text-subtle hover:text-fg",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="ml-auto hidden font-mono text-[10px] text-subtle md:block">
          {market
            ? `SOL ${fmtUsd(market.solUsd)}  ${fmtPct(market.solChange24h)} · ${market.fearLabel} ${market.fearGreed}`
            : "loading tape…"}
        </p>
      </div>
      <StartCapital startUsd={startUsd} onApply={onStart} />
      <div className="md:hidden">
        <AppNav />
      </div>
    </header>
  );
}
