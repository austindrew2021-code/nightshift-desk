import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/desk/shell";
import { useDesk } from "@/lib/store";
import { fmtCompact, fmtPct, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { curvePctFromMcap } from "@/lib/engine/pipeline";

export const Route = createFileRoute("/market")({ component: MarketPage });

function MarketPage() {
  const market = useDesk((s) => s.market);
  const loading = useDesk((s) => s.loadingMarket);
  const err = useDesk((s) => s.marketError);

  return (
    <Frame>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <h1 className="font-sans text-2xl tracking-tight text-fg">Market tape</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          CoinGlass-style derivatives from OKX, spot from the same feed, Fear & Greed, and live pump.fun launches. Used by the Timing agent.
        </p>
        {err && <p className="mt-3 font-mono text-xs text-loss">{err}</p>}
        {loading && !market && <p className="mt-6 font-mono text-xs text-subtle">Pulling feeds…</p>}

        {market && (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric k="SOL" v={fmtUsd(market.solUsd)} s={fmtPct(market.solChange24h)} up={market.solChange24h >= 0} />
              <Metric k="BTC" v={fmtUsd(market.btcUsd, 0)} s={fmtPct(market.btcChange24h)} up={market.btcChange24h >= 0} />
              <Metric
                k="SOL funding"
                v={`${(market.fundingSol * 100).toFixed(4)}%`}
                s="next period"
                up={market.fundingSol >= 0}
              />
              <Metric k="Fear & Greed" v={String(market.fearGreed)} s={market.fearLabel} up={market.fearGreed >= 50} />
              <Metric k="SOL OI" v={fmtUsd(market.oiSolUsd, 0)} s="OKX swap" up />
              <Metric
                k="Long / short"
                v={market.longShortSol.toFixed(2)}
                s="account ratio"
                up={market.longShortSol < 2.4}
              />
              <Metric k="Launches" v={String(market.launches.length)} s="pump.fun latest" up />
              <Metric k="15m bars" v={String(market.candles15.length)} s="ICT window" up />
            </div>

            <Spark candles={market.candles15} />

            {market.books.length > 0 && (
              <>
                <h2 className="mt-8 font-sans text-lg text-fg">ICT majors</h2>
                <p className="mb-3 font-mono text-[11px] text-subtle">
                  Live 15m books · OKX (NPC = KuCoin) · same candles the ICT desk trades
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {market.books.map((b) => (
                    <article
                      key={b.id}
                      className="rounded-xl bg-surface p-3 shadow-[0_0_0_1px_rgba(61,255,138,0.08)]"
                    >
                      <p className="font-mono text-[10px] tracking-[0.16em] text-subtle uppercase">
                        {b.symbol} · {b.source} · {b.candles15.length} bars
                      </p>
                      <p className="mt-1 font-mono text-lg tabular text-fg">
                        {b.last >= 10 ? fmtUsd(b.last, 2) : b.last.toPrecision(4)}
                      </p>
                      <p className={cn("font-mono text-xs tabular", b.change24h >= 0 ? "text-phosphor" : "text-loss")}>
                        {fmtPct(b.change24h)}
                      </p>
                    </article>
                  ))}
                </div>
              </>
            )}

            <h2 className="mt-8 font-sans text-lg text-fg">Live pump.fun</h2>
            <p className="mb-3 font-mono text-[11px] text-subtle">Newest mints · hunter feed · not a buy list</p>
            <div className="overflow-x-auto rounded-xl bg-surface shadow-[0_0_0_1px_rgba(61,255,138,0.08)]">
              <table className="w-full min-w-[640px] text-left font-mono text-[12px]">
                <thead className="text-[10px] tracking-[0.14em] text-subtle uppercase">
                  <tr>
                    <th className="px-3 py-2 font-medium">Token</th>
                    <th className="px-3 py-2 font-medium">Mcap</th>
                    <th className="px-3 py-2 font-medium">Curve</th>
                    <th className="px-3 py-2 font-medium">Social</th>
                    <th className="px-3 py-2 font-medium">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {market.launches.slice(0, 24).map((l) => {
                    const curve = curvePctFromMcap(l.usdMcap);
                    const age = Math.max(0, (Date.now() - l.createdAt) / 60000);
                    return (
                      <tr key={l.mint} className="border-t border-line">
                        <td className="px-3 py-2">
                          <p className="text-fg">{l.symbol}</p>
                          <p className="truncate text-[11px] text-subtle">{l.name}</p>
                        </td>
                        <td className="px-3 py-2 tabular text-fg">{fmtUsd(l.usdMcap, 0)}</td>
                        <td className="px-3 py-2 tabular text-phosphor">{curve.toFixed(0)}%</td>
                        <td className="px-3 py-2 text-muted">
                          {l.twitter ? "X " : ""}
                          {l.website ? "web " : ""}
                          {l.telegram ? "tg" : ""}
                          {!l.twitter && !l.website && !l.telegram ? "—" : ""}
                        </td>
                        <td className="px-3 py-2 tabular text-muted">{age.toFixed(1)}m</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 font-mono text-[10px] text-subtle">source {market.source}</p>
          </>
        )}
      </main>
    </Frame>
  );
}

function Metric({ k, v, s, up }: { k: string; v: string; s: string; up: boolean }) {
  return (
    <div className="rounded-xl bg-surface p-4 shadow-[0_0_0_1px_rgba(61,255,138,0.08)]">
      <p className="font-mono text-[10px] tracking-[0.16em] text-subtle uppercase">{k}</p>
      <p className={cn("mt-1 font-mono text-2xl tabular", up ? "text-fg" : "text-loss")}>{v}</p>
      <p className="mt-1 font-mono text-[11px] text-muted">{s}</p>
    </div>
  );
}

function Spark({ candles }: { candles: { c: number }[] }) {
  if (candles.length < 2) return null;
  const w = 800;
  const h = 120;
  const vals = candles.map((c) => c.c);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = Math.max(1e-6, max - min);
  const d = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = h - 8 - ((v - min) / span) * (h - 16);
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
  return (
    <div className="mt-6 rounded-xl bg-surface p-4 shadow-[0_0_0_1px_rgba(61,255,138,0.08)]">
      <p className="font-mono text-[10px] tracking-[0.16em] text-subtle uppercase">SOL 15m</p>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-28 w-full" preserveAspectRatio="none">
        <path d={d} fill="none" stroke="#3dff8a" strokeWidth="1.8" />
      </svg>
      <p className="font-mono text-[11px] text-muted">
        {fmtCompact(min)} – {fmtCompact(max)}
      </p>
    </div>
  );
}
