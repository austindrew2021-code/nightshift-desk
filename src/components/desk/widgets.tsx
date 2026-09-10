import type { AgentState, EquityPoint, Gauges } from "@/lib/engine/types";
import { fmtPct, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

export function EquityChart({
  series,
  start,
}: {
  series: EquityPoint[];
  start: number;
}) {
  const w = 640;
  const h = 220;
  const pad = { l: 8, r: 8, t: 16, b: 12 };
  const vals = series.length ? series.map((p) => p.v).filter((n) => Number.isFinite(n)) : [start];
  const min = Math.min(...vals, start) * 0.98;
  const max = Math.max(...vals, start) * 1.02;
  const span = Math.max(1, max - min);
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const pts = series.map((p, i) => {
    const x = pad.l + (i / Math.max(1, series.length - 1)) * innerW;
    const y = pad.t + (1 - (p.v - min) / span) * innerH;
    return { x, y, v: p.v };
  });
  let d = "";
  pts.forEach((p, i) => {
    if (i === 0) d += `M ${p.x} ${p.y}`;
    else {
      const prev = pts[i - 1]!;
      d += ` L ${p.x} ${prev.y} L ${p.x} ${p.y}`;
    }
  });
  const last = pts[pts.length - 1];
  const area = last
    ? `${d} L ${last.x} ${h - pad.b} L ${pts[0]!.x} ${h - pad.b} Z`
    : "";
  const lastV = vals[vals.length - 1] ?? start;
  const up = lastV >= start;

  return (
    <div className="relative h-full min-h-44">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={up ? "#3dff8a" : "#ff6b6b"} stopOpacity="0.35" />
            <stop offset="100%" stopColor={up ? "#3dff8a" : "#ff6b6b"} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((g) => (
          <line
            key={g}
            x1={pad.l}
            x2={w - pad.r}
            y1={pad.t + innerH * g}
            y2={pad.t + innerH * g}
            stroke="rgba(61,255,138,0.08)"
            strokeWidth="1"
          />
        ))}
        {area && <path d={area} fill="url(#eqFill)" />}
        {d && (
          <path
            d={d}
            fill="none"
            stroke={up ? "#3dff8a" : "#ff6b6b"}
            strokeWidth="2.2"
            strokeLinejoin="miter"
          />
        )}
      </svg>
      <div className="pointer-events-none absolute left-3 top-2">
        <p className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">equity · paper</p>
        <p className={cn("font-mono text-3xl tabular leading-none", up ? "text-phosphor" : "text-loss")}>
          {fmtUsd(lastV, 0)}
        </p>
      </div>
    </div>
  );
}

export function SparkRow({ agent }: { agent: AgentState }) {
  const w = 220;
  const h = 36;
  const vals = agent.spark.length ? agent.spark : [0];
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals, 1);
  const span = Math.max(1e-6, max - min);
  const d = vals
    .map((v, i) => {
      const x = (i / Math.max(1, vals.length - 1)) * w;
      const y = h - 4 - ((v - min) / span) * (h - 8);
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
  const last = Number.isFinite(vals[vals.length - 1]) ? (vals[vals.length - 1] as number) : 0;
  const up = last >= 0;
  return (
    <div className="flex min-w-0 items-center gap-3 px-3 py-1.5">
      <span
        className="w-16 shrink-0 font-mono text-[10px] tracking-wider"
        style={{ color: agent.color }}
      >
        {agent.name}
      </span>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-8 min-w-0 flex-1" preserveAspectRatio="none">
        <path d={d} fill="none" stroke={agent.color} strokeWidth="1.6" />
      </svg>
      <span className={cn("w-16 text-right font-mono text-[11px] tabular", up ? "text-phosphor" : "text-loss")}>
        {last >= 0 ? "+" : ""}
        {last.toFixed(1)}
      </span>
    </div>
  );
}

export function Gauge({
  value,
  label,
  sub,
}: {
  value: number;
  label: string;
  sub: string;
}) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  const dash = c * v;
  return (
    <div className="flex flex-col items-center gap-1 px-2 py-2">
      <svg viewBox="0 0 88 88" className="size-20">
        <circle cx="44" cy="44" r={r} fill="none" stroke="rgba(61,255,138,0.1)" strokeWidth="7" />
        <circle
          cx="44"
          cy="44"
          r={r}
          fill="none"
          stroke="#3dff8a"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform="rotate(-90 44 44)"
        />
        <text
          x="44"
          y="48"
          textAnchor="middle"
          fill="#d7efe0"
          fontFamily="IBM Plex Mono, monospace"
          fontSize="16"
        >
          {Math.round(v * 100)}%
        </text>
      </svg>
      <p className="font-mono text-[10px] tracking-[0.16em] text-fg uppercase">{label}</p>
      <p className="max-w-28 text-center font-sans text-[10px] leading-tight text-subtle">{sub}</p>
    </div>
  );
}

export function GaugeRow({ g }: { g: Gauges }) {
  return (
    <div className="flex items-center justify-around">
      <Gauge value={g.follow} label="follow rate" sub="how often the checker lets a fill through" />
      <Gauge value={g.decay} label="edge decay" sub="how fast the copy stops working" />
      <Gauge value={g.fill} label="fill quality" sub="slippage against the whole entry price" />
    </div>
  );
}

export function Multiplier({ equity, start }: { equity: number; start: number }) {
  const m = start > 0 && Number.isFinite(equity) ? equity / start : 1;
  return (
    <div className="absolute right-3 top-2 text-right">
      <p className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">multiple</p>
      <p className="font-mono text-xl text-fg tabular">{m.toFixed(1)}x</p>
      <p className={cn("font-mono text-xs tabular", equity >= start ? "text-phosphor" : "text-loss")}>
        {fmtPct(m - 1)}
      </p>
    </div>
  );
}
