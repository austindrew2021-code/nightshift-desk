import { useEffect, useMemo, useRef, useState } from "react";
import { chartLayers, nyHour, scanIct, type ChartZone, type IctSignal } from "@/lib/engine/ict";
import type { Candle } from "@/lib/engine/types";
import type { IctBook } from "@/lib/engine/universe";
import { ICT_ASSETS } from "@/lib/engine/universe";
import { cn } from "@/lib/utils";

const UP = "#3dff8a";
const DN = "#ff6b6b";
const GRID = "rgba(61,255,138,0.08)";
const MUTED = "rgba(122,154,134,0.9)";

function px(p: number) {
  if (!Number.isFinite(p)) return "—";
  const a = Math.abs(p);
  if (a >= 1000) return p.toFixed(1);
  if (a >= 100) return p.toFixed(2);
  if (a >= 1) return p.toFixed(3);
  return p.toFixed(5);
}

function nyLabel(t: number) {
  const h = Math.floor(nyHour(t));
  const m = Math.round((nyHour(t) - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const TOGGLES: { id: ChartZone["kind"]; label: string }[] = [
  { id: "fvg", label: "FVG" },
  { id: "ob", label: "OB" },
  { id: "asia", label: "ASIA" },
  { id: "nine", label: "9AM" },
  { id: "kill", label: "KZ" },
  { id: "entry", label: "FILLS" },
];

export function LiveChart({
  books,
  filter,
  fallback,
}: {
  books: IctBook[];
  filter: string;
  fallback?: Candle[];
}) {
  const [sym, setSym] = useState(filter === "ALL" ? "SOL" : filter);
  const [hover, setHover] = useState<number | null>(null);
  const [on, setOn] = useState<Record<string, boolean>>({
    fvg: true,
    ob: true,
    asia: true,
    nine: true,
    kill: true,
    entry: true,
    stop: true,
    target: true,
  });
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (filter !== "ALL") setSym(filter);
  }, [filter]);

  const book = books.find((b) => b.id === sym) ?? books.find((b) => b.id === "SOL") ?? books[0];
  const candles = book?.candles15?.length ? book.candles15 : fallback ?? [];
  const view = candles.slice(-96);
  const signals = useMemo(() => (candles.length >= 48 ? scanIct(candles) : []), [candles]);
  const zones = useMemo(() => chartLayers(view.length ? view : candles, signals), [view, candles, signals]);

  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    if (!el || !cv) return;

    const draw = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      cv.width = Math.max(1, Math.floor(w * dpr));
      cv.height = Math.max(1, Math.floor(h * dpr));
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (view.length < 2) {
        ctx.fillStyle = MUTED;
        ctx.font = "12px ui-monospace, monospace";
        ctx.fillText("Waiting for 15m books…", 16, h / 2);
        return;
      }

      const pad = { l: 8, r: 58, t: 8, b: 22 };
      const innerW = w - pad.l - pad.r;
      const innerH = h - pad.t - pad.b;
      const hi = Math.max(...view.map((c) => c.h));
      const lo = Math.min(...view.map((c) => c.l));
      const span = Math.max(1e-9, hi - lo) * 1.06;
      const mid = (hi + lo) / 2;
      const xAt = (t: number) => {
        const i = view.findIndex((c) => c.t >= t);
        const idx = i < 0 ? view.length - 1 : i;
        return pad.l + ((idx + 0.5) / view.length) * innerW;
      };
      const yAt = (p: number) => pad.t + (1 - (p - (mid - span / 2)) / span) * innerH;
      const slot = innerW / view.length;

      const vis = (k: ChartZone["kind"]) => on[k] !== false;

      ctx.save();
      ctx.beginPath();
      ctx.rect(pad.l, pad.t, innerW, innerH);
      ctx.clip();

      for (const z of zones) {
        if (z.kind !== "kill" || !vis("kill")) continue;
        const x0 = xAt(z.t0);
        const x1 = Math.max(x0 + 2, xAt(z.t1));
        ctx.fillStyle = "rgba(61,255,138,0.035)";
        ctx.fillRect(x0, pad.t, x1 - x0, innerH);
      }

      for (const z of zones) {
        if (z.kind === "asia" && vis("asia")) {
          ctx.fillStyle = "rgba(122,154,134,0.08)";
          ctx.fillRect(xAt(z.t0), yAt(z.top), Math.max(4, xAt(z.t1) - xAt(z.t0)), yAt(z.bot) - yAt(z.top));
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = "rgba(215,239,224,0.35)";
          ctx.beginPath();
          ctx.moveTo(xAt(z.t0), yAt(z.top));
          ctx.lineTo(xAt(z.t1), yAt(z.top));
          ctx.moveTo(xAt(z.t0), yAt(z.bot));
          ctx.lineTo(xAt(z.t1), yAt(z.bot));
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = MUTED;
          ctx.font = "10px ui-monospace, monospace";
          ctx.fillText("ASIA", xAt(z.t0) + 4, yAt(z.top) + 12);
        }
        if (z.kind === "nine" && vis("nine")) {
          ctx.fillStyle = "rgba(61,255,138,0.08)";
          ctx.strokeStyle = "rgba(61,255,138,0.45)";
          const x0 = xAt(z.t0);
          const x1 = xAt(z.t1);
          const y0 = yAt(z.top);
          const y1 = yAt(z.bot);
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
          ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
          ctx.fillStyle = UP;
          ctx.font = "10px ui-monospace, monospace";
          ctx.fillText("9AM", x0 + 4, y0 + 12);
        }
        if (z.kind === "fvg" && vis("fvg")) {
          ctx.fillStyle = z.dir === 1 ? "rgba(61,255,138,0.16)" : "rgba(255,107,107,0.16)";
          const x0 = xAt(z.t0);
          const x1 = Math.max(x0 + 6, xAt(z.t1));
          ctx.fillRect(x0, yAt(z.top), x1 - x0, yAt(z.bot) - yAt(z.top));
          ctx.fillStyle = z.dir === 1 ? UP : DN;
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillText(z.label, x0 + 3, yAt((z.top + z.bot) / 2) + 3);
        }
        if (z.kind === "ob" && vis("ob")) {
          ctx.fillStyle = z.dir === 1 ? "rgba(61,255,138,0.22)" : "rgba(255,107,107,0.22)";
          ctx.strokeStyle = z.dir === 1 ? UP : DN;
          const x0 = xAt(z.t0);
          const x1 = Math.max(x0 + 8, xAt(z.t1));
          const y0 = yAt(z.top);
          const yh = yAt(z.bot) - y0;
          ctx.fillRect(x0, y0, x1 - x0, yh);
          ctx.strokeRect(x0, y0, x1 - x0, yh);
          ctx.fillStyle = z.dir === 1 ? UP : DN;
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillText(z.label, x0 + 3, y0 + 11);
        }
      }

      for (let i = 0; i < view.length; i++) {
        const c = view[i]!;
        const x = pad.l + (i + 0.5) * slot;
        const up = c.c >= c.o;
        ctx.strokeStyle = up ? UP : DN;
        ctx.fillStyle = up ? UP : DN;
        ctx.beginPath();
        ctx.moveTo(x, yAt(c.h));
        ctx.lineTo(x, yAt(c.l));
        ctx.stroke();
        const y1 = yAt(Math.max(c.o, c.c));
        const y2 = yAt(Math.min(c.o, c.c));
        const bw = Math.max(2.2, slot * 0.62);
        ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
      }

      for (const z of zones) {
        if (!vis("entry")) continue;
        if (z.kind !== "entry" && z.kind !== "stop" && z.kind !== "target") continue;
        const x0 = xAt(z.t0);
        const x1 = xAt(z.t1);
        const y = yAt(z.top);
        ctx.setLineDash(z.kind === "entry" ? [] : [5, 4]);
        ctx.strokeStyle = z.kind === "stop" ? DN : UP;
        ctx.lineWidth = z.kind === "entry" ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (z.kind === "entry") {
          ctx.fillStyle = z.dir === 1 ? UP : DN;
          ctx.beginPath();
          ctx.moveTo(x0, y - 7);
          ctx.lineTo(x0 + 6, y);
          ctx.lineTo(x0, y + 7);
          ctx.lineTo(x0 - 6, y);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = z.kind === "stop" ? DN : UP;
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText(z.label, x1 - 28, y - 3);
      }

      ctx.restore();

      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      for (let g = 1; g <= 3; g++) {
        const y = pad.t + (innerH * g) / 4;
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(w - pad.r, y);
        ctx.stroke();
        const price = mid + span / 2 - (span * g) / 4;
        ctx.fillStyle = MUTED;
        ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.fillText(px(price), w - pad.r + 6, y + 3);
      }

      ctx.fillStyle = MUTED;
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "center";
      for (let i = 0; i < view.length; i += Math.ceil(view.length / 6)) {
        const c = view[i]!;
        ctx.fillText(nyLabel(c.t), pad.l + (i + 0.5) * slot, h - 6);
      }
      ctx.textAlign = "left";

      const hiC = hover != null ? view[hover] : view[view.length - 1];
      if (hiC) {
        const i = hover ?? view.length - 1;
        const x = pad.l + (i + 0.5) * slot;
        ctx.strokeStyle = "rgba(215,239,224,0.25)";
        ctx.beginPath();
        ctx.moveTo(x, pad.t);
        ctx.lineTo(x, pad.t + innerH);
        ctx.stroke();
      }
    };

    draw();
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [view, zones, on, hover]);

  function onMove(e: React.PointerEvent) {
    const el = wrap.current;
    if (!el || view.length < 2) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left - 8;
    const innerW = rect.width - 66;
    const i = Math.max(0, Math.min(view.length - 1, Math.floor((x / innerW) * view.length)));
    setHover(i);
  }

  const c = hover != null ? view[hover] : view[view.length - 1];
  const last = view[view.length - 1];
  const chg = last && view[0] ? (last.c - view[0]!.c) / view[0]!.c : 0;
  const liveSigs: IctSignal[] = signals.slice(-3);

  return (
    <div className="flex h-full min-h-[18rem] flex-col md:min-h-[22rem]">
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
        <p className="font-mono text-[10px] tracking-[0.18em] text-subtle uppercase">15m · NY</p>
        <div className="flex flex-wrap gap-1">
          {ICT_ASSETS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setSym(a.id)}
              className={cn(
                "h-6 rounded px-1.5 font-mono text-[10px] tracking-[0.1em]",
                a.id === (book?.id ?? sym) ? "bg-phosphor text-phosphor-ink" : "text-muted hover:text-fg",
              )}
            >
              {a.symbol}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-1">
          {TOGGLES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() =>
                setOn((s) => {
                  if (t.id === "entry") {
                    const next = s.entry === false;
                    return { ...s, entry: next, stop: next, target: next };
                  }
                  return { ...s, [t.id]: s[t.id] === false };
                })
              }
              className={cn(
                "h-6 rounded px-1.5 font-mono text-[10px]",
                on[t.id] !== false ? "text-phosphor" : "text-subtle",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-baseline gap-3 px-3 pt-1 font-mono text-[11px] tabular">
        <span className="text-fg">{book?.symbol ?? sym}</span>
        {c && (
          <>
            <span className="text-subtle">O {px(c.o)}</span>
            <span className="text-phosphor">H {px(c.h)}</span>
            <span className="text-loss">L {px(c.l)}</span>
            <span className="text-fg">C {px(c.c)}</span>
          </>
        )}
        <span className={chg >= 0 ? "text-phosphor" : "text-loss"}>
          {chg >= 0 ? "+" : ""}
          {(chg * 100).toFixed(2)}%
        </span>
        <span className="text-subtle">NY {c ? nyLabel(c.t) : "—"}</span>
      </div>
      <div
        ref={wrap}
        className="relative min-h-0 flex-1"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      </div>
      {liveSigs.length > 0 && (
        <p className="truncate px-3 pb-2 font-mono text-[10px] text-muted">
          {liveSigs.map((s) => `${s.setup} ${s.side} @ ${px(s.entry)}`).join(" · ")}
        </p>
      )}
    </div>
  );
}
