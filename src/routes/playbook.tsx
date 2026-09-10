import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/desk/shell";
import { useDesk } from "@/lib/store";
import { oddsFromTrades, scanIct, simulateIct } from "@/lib/engine/ict";
import { fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMemo } from "react";

export const Route = createFileRoute("/playbook")({ component: PlaybookPage });

const AGENTS = [
  { id: "HUNTER", color: "text-hunter", body: "WebSocket / latest mints. Keeps tokens with metadata, >5 buyers, curve <40%, age >2m." },
  { id: "AUDITOR", color: "text-auditor", body: "Holder concentration, snipers, social flags. Veto if creator-heavy or bundled." },
  { id: "NARRATIVE", color: "text-narrative", body: "The part a script cannot do — why this meme might travel this week. Optional Grok." },
  { id: "TIMING", color: "text-timing", body: "SOL regime, funding, Fear & Greed, TTrades kill zones. Cached, not per-token." },
  { id: "CHECKER", color: "text-checker", body: "Adversarial. Looks for reasons NOT to buy. Parse error = reject." },
];

const ICT = [
  { t: "A+ checklist", d: "Stop raid → market structure shift → discount/premium → PD array (FVG or order block). From TTrades." },
  { t: "Power of 3", d: "Accumulation (Asia range), Manipulation (London raid), Distribution (NY expansion). Video: ICT Power Of 3 — AMD." },
  { t: "Silver Bullet", d: "10:00–11:00 New York. Raid then FVG. One setup per window." },
  { t: "Kill zones", d: "London 02–05 NY, NY AM 07–10, Silver Bullet 10–11. No setups in the dead tape." },
  { t: "Risk", d: "1% risk, 2R target, stop beyond the sweep. Daily loss cap 22%. Max 3 open, 10 fills/day." },
];

function PlaybookPage() {
  const market = useDesk((s) => s.market);
  const closed = useDesk((s) => s.engine.closed);

  const ictOdds = useMemo(() => {
    if (!market || market.candles15.length < 40) return { trades: [], odds: oddsFromTrades(closed) };
    const trades = [
      ...simulateIct(market.candles15, scanIct(market.candles15), 12),
      ...simulateIct(market.candles1h, scanIct(market.candles1h), 12),
    ];
    return { trades, odds: oddsFromTrades([...trades, ...closed]) };
  }, [market, closed]);

  const { trades, odds } = ictOdds;
  const wr = trades.length ? trades.filter((t) => t.pnlUsd > 0).length / trades.length : 0;
  const exp = trades.length ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;

  return (
    <Frame>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <h1 className="font-sans text-2xl tracking-tight text-fg">Playbook</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Five Grok agents on pump.fun, TTrades ICT models on SOL, and setup odds before you press the paper button. Nothing here is a live order.
        </p>

        <h2 className="mt-8 font-sans text-lg text-fg">Five agents</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-5">
          {AGENTS.map((a) => (
            <article key={a.id} className="rounded-xl bg-surface p-4 shadow-[0_0_0_1px_rgba(61,255,138,0.08)]">
              <p className={cn("font-mono text-[11px] tracking-[0.16em]", a.color)}>{a.id}</p>
              <p className="mt-2 text-sm leading-relaxed text-muted">{a.body}</p>
            </article>
          ))}
        </div>

        <h2 className="mt-10 font-sans text-lg text-fg">ICT · TTrades</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {ICT.map((x) => (
            <article key={x.t} className="rounded-xl bg-surface p-4 shadow-[0_0_0_1px_rgba(61,255,138,0.08)]">
              <p className="font-sans text-sm text-fg">{x.t}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{x.d}</p>
            </article>
          ))}
        </div>

        <h2 className="mt-10 font-sans text-lg text-fg">Setup odds</h2>
        <p className="mt-1 text-sm text-muted">
          Know the setup on this sample before you trade it. ICT numbers are mechanical rules on the last {market?.candles15.length ?? 0} SOL 15m candles.
        </p>
        <div className="mt-3 rounded-xl bg-surface p-4 shadow-[0_0_0_1px_rgba(61,255,138,0.08)]">
          <p className="font-mono text-sm text-fg">
            ICT sample {trades.length} trades · win {fmtPct(wr)} · expectancy {exp.toFixed(2)}R
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {odds.map((o) => (
              <div key={o.setup} className="rounded-lg bg-panel p-3">
                <div className="flex items-baseline justify-between">
                  <p className="font-sans text-sm text-fg">{o.label}</p>
                  <p className="font-mono text-sm tabular text-phosphor">{fmtPct(o.winRate, 0)}</p>
                </div>
                <p className="mt-1 font-mono text-[11px] text-muted">
                  n={o.trades} · avg {o.avgR.toFixed(2)}R · {o.notes}
                </p>
              </div>
            ))}
          </div>
        </div>

        <h2 className="mt-10 font-sans text-lg text-fg">@zostaff 24h book (26 Aug 2026)</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Published numbers only. Tickers were never released. The desk scales this SOL ledger to your start using the live SOL snapshot, then replays from scratch.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl bg-surface shadow-[0_0_0_1px_rgba(61,255,138,0.08)]">
          <table className="w-full min-w-[520px] text-left font-mono text-[12px]">
            <thead className="text-[10px] tracking-[0.14em] text-subtle uppercase">
              <tr>
                <th className="px-3 py-2 font-medium">Fact</th>
                <th className="px-3 py-2 font-medium">Published</th>
                <th className="px-3 py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody className="text-fg">
              {[
                ["Start", "$1,000 at $1,000/SOL = 1.00 SOL", "video post"],
                ["Scanned", "18,000 launches in 24h", "video post"],
                ["Fills", "11 · daily cap hit · no second session", "video post"],
                ["Losses", "7 stopped −50% in <3m · avg −0.08 SOL · −0.56 SOL", "video post"],
                ["Wins", "4 · +82 SOL · one 190×, 40s after launch to graduation", "video post"],
                ["Net", "~80 SOL after fees/Jito ≈ $80,000", "video post"],
                ["Size cap", "claimed 0.1 SOL/fill — does not fit +82 SOL with one 190×", "conflict"],
                ["Typical day", "0.5–3 SOL. This day is a tail event.", "video post"],
                ["Tickers", "never released · fills labeled unpublished", "article"],
              ].map(([k, v, s]) => (
                <tr key={k} className="border-t border-line">
                  <td className="px-3 py-2 text-muted">{k}</td>
                  <td className="px-3 py-2">{v}</td>
                  <td className="px-3 py-2 text-subtle">{s}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 font-mono text-[11px] text-subtle">
          Three of the four winners have no published PnL. The replay splits the leftover +12 SOL of the +82 SOL win book across them and labels those implied. Skip tape uses today's live pump.fun names.
        </p>

        <h2 className="mt-10 font-sans text-lg text-fg">Sources</h2>
        <ul className="mt-2 space-y-1 text-sm text-muted">
          <li>TTrades Education Center — ICT core / Power of 3 / Silver Bullet</li>
          <li>CoinGlass-style derivatives via OKX public API (funding, OI, long/short)</li>
          <li>pump.fun latest mints via the public frontend API</li>
          <li>@zostaff five-agent pipeline (dry-run architecture, GitHub grokbot-pumpfun)</li>
        </ul>
      </main>
    </Frame>
  );
}
