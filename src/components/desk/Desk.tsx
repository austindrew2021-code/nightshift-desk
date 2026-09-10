import { useMemo } from "react";
import { fmtUsd, fmtClock, fmtSigned } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useDesk } from "@/lib/store";
import { consultGrok } from "@/lib/market/api";
import { TopBar } from "./shell";
import { AgentFloor, Heatmap } from "./floor";
import { EquityChart, GaugeRow, Multiplier, SparkRow } from "./widgets";
import { Button } from "@/components/ui/button";
import { InstallHint } from "./install";
import { zostaffScale } from "@/lib/engine/zostaff";
import { ICT_ASSETS } from "@/lib/engine/universe";

const TONE: Record<string, string> = {
  up: "text-phosphor",
  down: "text-loss",
  warn: "text-warn",
  mute: "text-muted",
};

export function Desk() {
  const engine = useDesk((s) => s.engine);
  const market = useDesk((s) => s.market);
  const grokBusy = useDesk((s) => s.grokBusy);
  const grokNote = useDesk((s) => s.grokNote);
  const play = useDesk((s) => s.play);
  const pause = useDesk((s) => s.pause);
  const reset = useDesk((s) => s.reset);
  const setSpeed = useDesk((s) => s.setSpeed);
  const setMode = useDesk((s) => s.setMode);
  const setStartUsd = useDesk((s) => s.setStartUsd);
  const setIctFilter = useDesk((s) => s.setIctFilter);
  const setGrok = useDesk((s) => s.setGrok);
  const bumpGrok = useDesk((s) => s.bumpGrokCalls);

  const startUsd = engine.startUsd;
  const sessionPnlUsd = engine.equityUsd - startUsd;
  const sessionPnlSol = sessionPnlUsd / Math.max(1e-6, engine.solUsd);
  const z = zostaffScale(startUsd, engine.solUsd);

  const modeHint = useMemo(() => {
    switch (engine.mode) {
      case "live":
        return `Live paper · Zostaff method from $${startUsd.toFixed(0)} · 0.1 SOL cap · 50% stop · 1% pump fee + Jito + curve slip · mcap from pump.fun. Not a wallet.`;
      case "ict":
        return `ICT ${engine.ictFilter} from $${startUsd.toFixed(0)} · TTrades Silver Bullet / Power of 3 on live 15m (BTC ETH SOL XRP XLM TAO NPC + liquid names). Mechanical, not scripted.`;
      case "zostaff":
        return `Zostaff from scratch $${startUsd.toFixed(0)} = ${z.startSol.toFixed(3)} SOL · published 1→80 SOL replay, not today's tape. Tickers never released.`;
      default:
        return `Watch · same Zostaff method as live paper, faster hunter on the live queue · fees still apply.`;
    }
  }, [engine.mode, engine.ictFilter, startUsd, z.startSol, z.targetEndUsd]);

  async function askGrok() {
    if (grokBusy) return;
    if (engine.stats.grokCalls >= 8) {
      setGrok(false, "Grok call cap reached for this session.");
      return;
    }
    const ev = engine.tape.find((t) => t.kind === "scan" || t.kind === "pass");
    const launch = market?.launches[0];
    const symbol = ev?.symbol ?? launch?.symbol ?? "TOKEN";
    const name = launch?.name ?? symbol;
    setGrok(true, null);
    bumpGrok();
    try {
      const res = await consultGrok({
        data: {
          symbol,
          name,
          description: launch?.description ?? ev?.text ?? "",
          metrics: `sol=${engine.solUsd.toFixed(2)} funding=${(market?.fundingSol ?? 0).toFixed(4)} fng=${market?.fearGreed ?? "?"} scanned=${engine.stats.scanned}`,
        },
      });
      if (!res.ok) {
        setGrok(false, res.error);
        return;
      }
      setGrok(
        false,
        `${symbol}  fit ${res.narrative_fit.toFixed(2)}  virality ${res.virality.toFixed(2)}  ${res.approve ? "approve" : "reject"} (${res.confidence.toFixed(2)}) — ${res.reason}`,
      );
    } catch (err) {
      setGrok(false, err instanceof Error ? err.message : "Grok call failed");
    }
  }

  return (
    <div className="desk-shell min-h-dvh overflow-x-hidden pb-16">
      <TopBar
        equityUsd={engine.equityUsd}
        startUsd={startUsd}
        solUsd={engine.solUsd}
        stats={engine.stats}
        simT={engine.simT}
        running={engine.running}
        speed={engine.speed}
        mode={engine.mode}
        onPlay={play}
        onPause={pause}
        onReset={() => reset()}
        onSpeed={setSpeed}
        onMode={setMode}
        onStart={setStartUsd}
        market={market}
      />

      <p className="border-b border-line px-4 py-2 font-mono text-[11px] text-subtle">{modeHint}</p>

      {engine.mode === "ict" && (
        <div className="flex flex-wrap gap-1 border-b border-line px-4 py-2">
          {[{ id: "ALL", symbol: "ALL" }, ...ICT_ASSETS].map((a) => {
            const on = engine.ictFilter === a.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setIctFilter(a.id)}
                className={cn(
                  "h-9 rounded-md px-2.5 font-mono text-[11px] tracking-[0.12em] uppercase",
                  on ? "bg-phosphor text-phosphor-ink" : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                {a.symbol}
              </button>
            );
          })}
        </div>
      )}

      <div className="grid gap-px bg-line md:grid-cols-12">
        <section className="relative bg-surface p-3 md:col-span-4">
          <EquityChart series={engine.equity} start={startUsd} />
          <Multiplier equity={engine.equityUsd} start={startUsd} />
        </section>

        <section className="bg-surface md:col-span-5">
          <p className="px-3 pt-2 font-mono text-[10px] tracking-[0.18em] text-subtle uppercase">
            tracked wallets · agent score line
          </p>
          {engine.agents.map((a) => (
            <SparkRow key={a.id} agent={a} />
          ))}
        </section>

        <section className="bg-surface p-2 md:col-span-3">
          <GaugeRow g={engine.gauges} />
        </section>

        <section className="bg-surface p-2 md:col-span-12">
          <AgentFloor agents={engine.agents} />
        </section>

        <section className="bg-surface md:col-span-3">
          <p className="px-3 pt-2 font-mono text-[10px] tracking-[0.18em] text-subtle uppercase">
            hunter activity
          </p>
          <div className="h-36">
            <Heatmap cells={engine.heatmap} />
          </div>
        </section>

        <section className="bg-surface md:col-span-6">
          <p className="px-3 pt-2 font-mono text-[10px] tracking-[0.18em] text-subtle uppercase">
            desk tape
          </p>
          <ul className="max-h-44 overflow-auto px-3 py-2 font-mono text-[11px] leading-5">
            {engine.tape.slice(0, 18).map((e) => (
              <li key={e.id} className={cn("flex gap-2 tabular", TONE[e.tone])}>
                <span className="w-16 shrink-0 text-subtle">{fmtClock(e.t)}</span>
                <span className="w-16 shrink-0 uppercase text-muted">{e.kind}</span>
                <span className="min-w-0 flex-1 truncate">{e.text}</span>
              </li>
            ))}
            {engine.tape.length === 0 && (
              <li className="text-subtle">Waiting for the hunter to attach…</li>
            )}
          </ul>
        </section>

        <section className="flex flex-col justify-between bg-surface p-4 md:col-span-3">
          <div>
            <p className="font-mono text-[10px] tracking-[0.18em] text-subtle uppercase">session pnl</p>
            <p className={cn("font-mono text-3xl tabular", sessionPnlSol >= 0 ? "text-phosphor" : "text-loss")}>
              {sessionPnlSol >= 0 ? "+" : ""}
              {sessionPnlSol.toFixed(2)} SOL
            </p>
            <p className="mt-1 font-mono text-xs text-muted tabular">
              book {fmtUsd(engine.equityUsd)} · cash {fmtUsd(engine.cashUsd)} · start {fmtUsd(startUsd)}
            </p>
            <p className="mt-1 font-mono text-[11px] text-subtle tabular">
              fees {fmtUsd(engine.stats.feesUsd)} · jito {fmtUsd(engine.stats.jitoUsd)} · drag{" "}
              {fmtUsd(engine.stats.feesUsd + engine.stats.jitoUsd)}
            </p>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-2 font-mono text-center text-[11px] tabular">
            <Stat k="open" v={String(engine.open.length)} />
            <Stat k="wins" v={String(engine.stats.wins)} />
            <Stat k="loss" v={String(engine.stats.losses)} />
            <Stat k="veto" v={String(engine.stats.vetoed)} />
          </div>
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Button size="sm" variant="outline" disabled={grokBusy} onClick={() => void askGrok()}>
          {grokBusy ? "Grok reading…" : "Consult Grok"}
        </Button>
        <p className="font-mono text-[11px] text-subtle">
          {grokNote ?? `Grok calls ${engine.stats.grokCalls}/8 · user-initiated, capped.`}
        </p>
        <p className="ml-auto max-w-xl text-right font-sans text-[11px] text-subtle">
          Paper desk. Live paper is the Zostaff method on today's mints with 1% fee, Jito, and curve slippage. ICT is mechanical on live 15m majors. Zostaff run is the published 80× replay. No wallet.
        </p>
      </div>

      {engine.open.length > 0 && (
        <div className="px-4 pb-4">
          <p className="mb-2 font-mono text-[10px] tracking-[0.18em] text-subtle uppercase">open book</p>
          <div className="grid gap-2 md:grid-cols-3">
            {engine.open.map((p) => (
              <div key={p.id} className="rounded-lg bg-surface p-3 shadow-[0_0_0_1px_rgba(61,255,138,0.08)]">
                <div className="flex items-baseline justify-between">
                  <p className="font-mono text-sm text-fg">{p.symbol}</p>
                  <p className={cn("font-mono text-sm tabular", p.pnlUsd >= 0 ? "text-phosphor" : "text-loss")}>
                    {fmtSigned(p.pnlUsd)}
                  </p>
                </div>
                <p className="mt-1 font-mono text-[11px] text-muted">{p.note}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <InstallHint />
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <p className="text-subtle tracking-[0.14em] uppercase">{k}</p>
      <p className="text-fg">{v}</p>
    </div>
  );
}
