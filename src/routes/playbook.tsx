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
  { t: "Bias first", d: "TTrades: 5h slope first. No long into a sell day, no short into a buy day." },
  { t: "Power of 3", d: "Asia accumulates, London puts the daily wick, NY is the body. Drawn as the Asia box on the 15m chart." },
  { t: "CISD + Silver Bullet", d: "Sweep alone is not a trade. SB is 10–11 NY on the 9am hour, CISD, FVG, other side of that hour." },
  { t: "Order block / Unicorn", d: "Last opposite candle before displacement. Unicorn = that OB overlapping the FVG. Boxes on the chart." },
  { t: "FVG + divergence", d: "FVG entry at CE in premium/discount. Regular + hidden RSI. SMT: BTC vs ETH failed swing." },
];

function PlaybookPage() {
  const market = useDesk((s) => s.market);
  const closed = useDesk((s) => s.engine.closed);

  const ictOdds = useMemo(() => {
    const books = market?.books ?? [];
    const fromBooks = books.flatMap((b) =>
      b.candles15.length >= 40 ? simulateIct(b.candles15, scanIct(b.candles15), 12, b.symbol, b.name) : [],
    );
    const fromSol =
      market && market.candles15.length >= 40 && !fromBooks.length
        ? [
            ...simulateIct(market.candles15, scanIct(market.candles15), 12),
            ...simulateIct(market.candles1h, scanIct(market.candles1h), 12),
          ]
        : [];
    const trades = fromBooks.length ? fromBooks : fromSol;
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
          Five Grok agents on pump.fun, TTrades ICT on live 15m majors, and setup odds before you press paper. Nothing here is a live order.
        </p>

        <h2 className="mt-8 font-sans text-lg text-fg">How to run a real test</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {[
            {
              t: "1. Do not use Zostaff run",
              d: "That button replays their published 1→80 SOL book. It is reconstructed. It will always land on ~80× from your start. That is not a test.",
            },
            {
              t: "2. Live paper — pump.fun method",
              d: "Set $100 (or $1k). Tap Live paper. Leave it running. Max 10 fills/day, 0.1 SOL cap, 50% stop. Many hours can pass with 0 fills — the filter is supposed to skip almost everything. Overnight is a start. A week is a real sample.",
            },
            {
              t: "3. ICT · majors — TTrades on live 15m",
              d: "Tap ICT · majors. It first replays the last ~2 days of 15m on BTC ETH SOL XRP XLM TAO NPC + BNB DOGE AVAX LINK HYPE. Then it stays on and picks up new Silver Bullet / AMD signals as 15m bars print. Leave it through at least one NY 10–11 ET window. Five sessions is a real sample.",
            },
            {
              t: "4. What “accurate” means",
              d: "Live paper and ICT PnL come from live prints and mechanical rules. They can lose. They are still paper: 8–20s poll, modeled pump fees, no mempool, no failed txs. Unique buyers on pump.fun are estimated when the API omits holders.",
            },
          ].map((x) => (
            <article key={x.t} className="rounded-xl bg-surface p-4 shadow-[0_0_0_1px_rgba(61,255,138,0.08)]">
              <p className="font-sans text-sm text-fg">{x.t}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{x.d}</p>
            </article>
          ))}
        </div>

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

        <h2 className="mt-10 font-sans text-lg text-fg">Live paper = Zostaff method</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Live paper is the five-agent pipeline on today's pump.fun tape, not the 80× replay. Zostaff run is the published 24h book. Use Live paper if you want to see how the rules do now.
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {[
            { t: "Filters", d: "Metadata, >5 buyers (estimated from reserves if pump.fun omits holders), curve <40%, age >2m, risk ≤7, score ≥0.65, checker veto." },
            { t: "Size", d: "0.1 SOL cap (their video), 8% of book, 3 open, 10 fills/day, 22% daily loss, size shrinks as the daily limit is spent." },
            { t: "Exits", d: "50% stop. Winners trail 35% off peak after 1.4×. No small take-profit — they rode the 190×. Losers time-out at 60m if still red." },
            { t: "Costs on every fill", d: "1% pump.fun fee in and out, 0.001 SOL Jito tip each side, curve impact from virtual+real SOL. Open PnL is haircut as if you flattened now." },
          ].map((x) => (
            <article key={x.t} className="rounded-xl bg-surface p-4 shadow-[0_0_0_1px_rgba(61,255,138,0.08)]">
              <p className="font-sans text-sm text-fg">{x.t}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{x.d}</p>
            </article>
          ))}
        </div>
        <p className="mt-3 font-mono text-[11px] text-subtle">
          Still paper. Poll is ~8s, not a mempool fill. No MEV, no failed landings, no on-chain holder map. Drag is modeled; speed of entry is not.
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
