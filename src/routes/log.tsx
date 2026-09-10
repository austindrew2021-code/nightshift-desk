import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/desk/shell";
import { useDesk } from "@/lib/store";
import { fmtClock, fmtSigned, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/log")({ component: LogPage });

function LogPage() {
  const tape = useDesk((s) => s.engine.tape);
  const closed = useDesk((s) => s.engine.closed);
  const stats = useDesk((s) => s.engine.stats);

  return (
    <Frame>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <h1 className="font-sans text-2xl tracking-tight text-fg">Desk log</h1>
        <p className="mt-1 text-sm text-muted">
          JSONL-style paper log. {stats.scanned} scanned · {stats.taken} fills · {stats.vetoed} vetoes.
        </p>

        <h2 className="mt-8 font-sans text-lg text-fg">Closed fills</h2>
        <div className="mt-2 overflow-x-auto rounded-xl bg-surface shadow-[0_0_0_1px_rgba(61,255,138,0.08)]">
          <table className="w-full min-w-[640px] text-left font-mono text-[12px]">
            <thead className="text-[10px] tracking-[0.14em] text-subtle uppercase">
              <tr>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Sym</th>
                <th className="px-3 py-2 font-medium">Setup</th>
                <th className="px-3 py-2 font-medium">Reason</th>
                <th className="px-3 py-2 font-medium">R</th>
                <th className="px-3 py-2 font-medium">PnL</th>
                <th className="px-3 py-2 font-medium">Origin</th>
              </tr>
            </thead>
            <tbody>
              {closed.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-subtle" colSpan={7}>
                    No closes yet — let the backtest run from your start.
                  </td>
                </tr>
              )}
              {closed.map((t) => (
                <tr key={t.id} className="border-t border-line">
                  <td className="px-3 py-2 text-subtle">{fmtClock(t.closedAt)}</td>
                  <td className="px-3 py-2 text-fg">{t.symbol}</td>
                  <td className="px-3 py-2 text-muted">{t.setup}</td>
                  <td className="px-3 py-2 text-muted">{t.reason}</td>
                  <td className="px-3 py-2 tabular">{t.rMultiple.toFixed(2)}</td>
                  <td className={cn("px-3 py-2 tabular", t.pnlUsd >= 0 ? "text-phosphor" : "text-loss")}>
                    {fmtSigned(t.pnlUsd)}
                  </td>
                  <td className="px-3 py-2 text-subtle">{t.origin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="mt-8 font-sans text-lg text-fg">Tape</h2>
        <ul className="mt-2 max-h-[480px] overflow-auto rounded-xl bg-surface p-3 font-mono text-[11px] leading-6 shadow-[0_0_0_1px_rgba(61,255,138,0.08)]">
          {tape.map((e) => (
            <li key={e.id} className="flex gap-3">
              <span className="w-16 text-subtle">{fmtClock(e.t)}</span>
              <span className="w-14 uppercase text-muted">{e.kind}</span>
              <span className="text-fg">{e.text}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 font-mono text-[10px] text-subtle">
          {fmtUsd(0)} bookkeeping is paper. Past ticks are not a promise.
        </p>
      </main>
    </Frame>
  );
}
