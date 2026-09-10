import type { AgentState } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

const SLOTS: { id: string; x: string; y: string }[] = [
  { id: "hunter", x: "18%", y: "42%" },
  { id: "auditor", x: "34%", y: "38%" },
  { id: "narrative", x: "48%", y: "44%" },
  { id: "timing", x: "64%", y: "36%" },
  { id: "checker", x: "78%", y: "48%" },
];

function Bot({ color, busy, label }: { color: string; busy: boolean; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <svg viewBox="0 0 40 48" className={cn("h-12 w-10", busy && "animate-[ns-pulse_1.8s_ease-in-out_infinite]")}>
        <rect x="12" y="2" width="16" height="6" rx="2" fill={color} opacity="0.85" />
        <rect x="8" y="10" width="24" height="18" rx="4" fill={color} />
        <rect x="13" y="15" width="5" height="5" fill="#070b09" />
        <rect x="22" y="15" width="5" height="5" fill="#070b09" />
        <rect x="16" y="23" width="8" height="2" fill="#070b09" opacity="0.5" />
        <rect x="6" y="30" width="28" height="12" rx="3" fill={color} opacity="0.85" />
        <rect x="2" y="32" width="6" height="3" rx="1" fill={color} />
        <rect x="32" y="32" width="6" height="3" rx="1" fill={color} />
      </svg>
      <span className="font-mono text-[9px] tracking-[0.16em] uppercase" style={{ color }}>
        {label}
      </span>
    </div>
  );
}

export function AgentFloor({ agents }: { agents: AgentState[] }) {
  return (
    <div className="relative h-48 overflow-hidden rounded-lg bg-panel md:h-56">
      <div className="pointer-events-none absolute inset-x-6 top-6 bottom-0 [perspective:700px]">
        <div className="floor-grid absolute inset-0 opacity-80" />
      </div>
      <p className="absolute left-3 top-2 font-mono text-[10px] tracking-[0.2em] text-subtle uppercase">
        five agents · live
      </p>
      {SLOTS.map((s) => {
        const a = agents.find((x) => x.id === s.id);
        if (!a) return null;
        return (
          <div
            key={s.id}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: s.x, top: s.y }}
          >
            <Bot color={a.color.startsWith("var") ? defaultColor(a.id) : a.color} busy={a.busy} label={a.name} />
          </div>
        );
      })}
    </div>
  );
}

function defaultColor(id: string) {
  switch (id) {
    case "hunter":
      return "#3dff8a";
    case "auditor":
      return "#5aa8ff";
    case "narrative":
      return "#7ee0c3";
    case "timing":
      return "#8ea2ff";
    default:
      return "#ff7a6e";
  }
}

export function Heatmap({ cells }: { cells: number[] }) {
  const cols = 24;
  const rows = 8;
  return (
    <div className="grid h-full gap-px p-2" style={{ gridTemplateColumns: "repeat(24, minmax(0,1fr))" }}>
      {Array.from({ length: rows * cols }, (_, i) => {
        const v = cells[i] ?? 0;
        return (
          <div
            key={i}
            className="aspect-square rounded-[1px]"
            style={{ background: `rgba(61,255,138,${0.06 + v * 0.7})` }}
          />
        );
      })}
    </div>
  );
}
