import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { chartLayers, nyHour, type ChartZone } from "@/lib/engine/ict";
import type { Candle, ClosedTrade, Position } from "@/lib/engine/types";
import { CHART_BARS, ICT_ASSETS, type IctBook } from "@/lib/engine/universe";
import { fetchChartKlines } from "@/lib/market/api";
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
  const m = Math.round((nyHour(t) - h) * 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function nextIctHint(now = Date.now()) {
  const h = nyHour(now);
  if (h >= 2 && h < 5) return "London AMD 2–5 NY · live";
  if (h >= 7 && h < 10) return "Judas 7–10 NY · live";
  if (h >= 10 && h < 11) return "Silver Bullet 10–11 NY · live";
  if (h >= 14 && h < 15) return "PM Silver Bullet 2–3 NY · live";
  if (h >= 13.5 && h < 16) return "PM scalp 1:30–4 NY · live";
  if (h < 2) return "next London 2–5 NY";
  if (h < 7) return "next Judas 7–10 NY";
  if (h < 10) return "next Silver Bullet 10–11 NY";
  if (h < 14) return "next PM Silver Bullet 2–3 NY";
  return "next London 2–5 NY (3–6 AM ADT)";
}

const TOGGLES: { id: ChartZone["kind"] | "orders"; label: string }[] = [
  { id: "fvg", label: "FVG" },
  { id: "ob", label: "OB" },
  { id: "asia", label: "ASIA" },
  { id: "nine", label: "9AM" },
  { id: "daily", label: "DAY" },
  { id: "weekly", label: "WK" },
  { id: "fib", label: "FIB" },
  { id: "ote", label: "OTE" },
  { id: "grab", label: "GRAB" },
  { id: "kill", label: "KZ" },
  { id: "entry", label: "FILLS" },
  { id: "orders", label: "ORDERS" },
];

export function ChipRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative min-w-0", className)}>
      <div
        className="min-w-0 w-full overflow-x-auto overscroll-x-contain [scrollbar-width:thin] [-webkit-overflow-scrolling:touch]"
        style={{ touchAction: "pan-x" }}
      >
        <div className="flex w-max gap-1 px-3 py-1 pr-10">{children}</div>
      </div>
      <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-surface to-transparent" />
    </div>
  );
}

export interface ChartOrder {
  id: string;
  symbol: string;
  side: "long" | "short";
  setup: string;
  entry: number;
  stop?: number;
  target?: number;
  exit?: number;
  openedAt: number;
  closedAt?: number;
  live: boolean;
  pending?: boolean;
  pnlUsd?: number;
  reason?: string;
}

function posLevels(p: Position): { stop: number; target: number } {
  const stop =
    p.stopUsd ??
    (p.side === "long" ? p.entryUsd * (1 - p.stopPct) : p.entryUsd * (1 + p.stopPct));
  const target =
    p.targetUsd ??
    (p.side === "long" ? p.entryUsd * (1 + p.stopPct * p.targetR) : p.entryUsd * (1 - p.stopPct * p.targetR));
  return { stop, target };
}

export function deskOrders(open: Position[], closed: ClosedTrade[]): ChartOrder[] {
  const live: ChartOrder[] = open.map((p) => {
    const lv = posLevels(p);
    return {
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      setup: p.setup,
      entry: p.entryUsd,
      stop: lv.stop,
      target: lv.target,
      openedAt: p.openedAt,
      live: true,
      pnlUsd: p.pnlUsd,
    };
  });
  const done: ChartOrder[] = closed.slice(0, 12).map((t) => ({
    id: t.id,
    symbol: t.symbol,
    side: t.side,
    setup: t.setup,
    entry: t.entryUsd,
    stop: t.stopUsd,
    target: t.targetUsd,
    exit: t.exitUsd,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    live: false,
    pnlUsd: t.pnlUsd,
    reason: t.reason,
  }));
  return [...live, ...done];
}

export function LiveChart({
  books,
  filter,
  fallback,
  fullscreen,
  onToggleFs,
  orders = [],
}: {
  books: IctBook[];
  filter: string;
  fallback?: Candle[];
  fullscreen?: boolean;
  onToggleFs?: () => void;
  orders?: ChartOrder[];
}) {
  const [sym, setSym] = useState(filter === "ALL" ? "SOL" : filter);
  const [tf, setTf] = useState("5m");
  const [hover, setHover] = useState<number | null>(null);
  const [span, setSpan] = useState(72);
  const [start, setStart] = useState(0);
  const [follow, setFollow] = useState(true);
  const [on, setOn] = useState<Record<string, boolean>>({
    fvg: true,
    ob: true,
    asia: true,
    nine: true,
    kill: true,
    entry: true,
    stop: true,
    target: true,
    orders: true,
  });
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{
    x: number;
    start: number;
    moved: boolean;
    ids: Map<number, { x: number; y: number }>;
    pinch: number | null;
    span0: number;
  }>({ x: 0, start: 0, moved: false, ids: new Map(), pinch: null, span0: 72 });

  useEffect(() => {
    if (filter !== "ALL") setSym(filter);
  }, [filter]);

  const book = books.find((b) => b.id === sym) ?? books.find((b) => b.id === "SOL") ?? books[0];
  const tape = useQuery({
    queryKey: ["chart-klines", sym, tf],
    queryFn: () => fetchChartKlines({ id: sym, bar: tf }),
    refetchInterval: tf === "1m" || tf === "5m" ? 3_000 : 5_000,
    staleTime: 1_000,
  });
  const liveTape = tape.data?.id === sym && tape.data.bar === tf ? tape.data : null;
  const candles =
    liveTape && liveTape.candles.length > 8
      ? liveTape.candles
      : book?.candles15?.length
        ? book.candles15
        : (fallback ?? []);
  const nAll = candles.length;
  const visN = Math.max(20, Math.min(span, nAll || 20));
  const visStart = follow ? Math.max(0, nAll - visN) : clamp(start, 0, Math.max(0, nAll - visN));
  const view = nAll ? candles.slice(visStart, visStart + visN) : [];
  const zones = useMemo(() => chartLayers(view.length ? view : candles, []), [view, candles]);
  const stale = book?.source === "fallback" || (!book && (fallback?.length ?? 0) > 0);
  const lastPx = liveTape?.last || book?.last || view[view.length - 1]?.c || 0;
  const mine = useMemo(() => {
    return orders.filter((o) => o.symbol === (book?.symbol ?? sym) || o.symbol === (book?.id ?? sym));
  }, [orders, book?.symbol, book?.id, sym]);

  useEffect(() => {
    if (follow && nAll > 0) setStart(Math.max(0, nAll - visN));
  }, [follow, nAll, visN]);

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

      const pad = { l: 16, r: on.orders !== false && mine.length ? 92 : 56, t: 6, b: 22 };
      const innerW = w - pad.l - pad.r;
      const innerH = h - pad.t - pad.b;
      const hi = Math.max(...view.map((c) => c.h));
      const lo = Math.min(...view.map((c) => c.l));
      const spanPx = Math.max(1e-9, hi - lo) * 1.12;
      const mid = (hi + lo) / 2;
      const xAt = (t: number) => {
        const i = view.findIndex((c) => c.t >= t);
        const idx = i < 0 ? view.length - 1 : i;
        return pad.l + ((idx + 0.5) / view.length) * innerW;
      };
      const yAt = (p: number) => pad.t + (1 - (p - (mid - spanPx / 2)) / spanPx) * innerH;
      const slot = innerW / view.length;
      const vis = (k: ChartZone["kind"]) => on[k] !== false;
      const labelX = (x: number) => clamp(x, pad.l + 2, w - pad.r - 36);

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
          ctx.fillText("ASIA", labelX(xAt(z.t0) + 4), yAt(z.top) + 12);
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
          ctx.fillText("9AM", labelX(x0 + 4), y0 + 12);
        }
        if (z.kind === "daily" && vis("daily")) {
          const x0 = xAt(z.t0);
          const x1 = Math.max(x0 + 8, xAt(z.t1));
          const eq = (z.top + z.bot) / 2;
          ctx.setLineDash([6, 5]);
          ctx.strokeStyle = "rgba(138,162,255,0.7)";
          ctx.beginPath();
          ctx.moveTo(x0, yAt(z.top));
          ctx.lineTo(x1, yAt(z.top));
          ctx.moveTo(x0, yAt(z.bot));
          ctx.lineTo(x1, yAt(z.bot));
          ctx.stroke();
          ctx.strokeStyle = "rgba(138,162,255,0.35)";
          ctx.beginPath();
          ctx.moveTo(x0, yAt(eq));
          ctx.lineTo(x1, yAt(eq));
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(138,162,255,0.85)";
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillText("PDH", labelX(x0 + 4), yAt(z.top) + 11);
          ctx.fillText("PDL", labelX(x0 + 4), yAt(z.bot) - 3);
          ctx.fillText("EQ", labelX(x0 + 4), yAt(eq) - 3);
        }
        if (z.kind === "weekly" && vis("weekly")) {
          const x0 = xAt(z.t0);
          const x1 = Math.max(x0 + 8, xAt(z.t1));
          ctx.setLineDash([2, 6]);
          ctx.strokeStyle = "rgba(255,196,90,0.65)";
          ctx.beginPath();
          ctx.moveTo(x0, yAt(z.top));
          ctx.lineTo(x1, yAt(z.top));
          ctx.moveTo(x0, yAt(z.bot));
          ctx.lineTo(x1, yAt(z.bot));
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(255,196,90,0.85)";
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillText("PWH", labelX(x0 + 4), yAt(z.top) + 11);
          ctx.fillText("PWL", labelX(x0 + 4), yAt(z.bot) - 3);
        }
        if (z.kind === "fib" && vis("fib")) {
          const x0 = xAt(z.t0);
          const x1 = Math.max(x0 + 8, xAt(z.t1));
          const strong = z.label === "61.8" || z.label === "70.5" || z.label === "78.6";
          ctx.setLineDash(z.label === "50" ? [8, 4] : [3, 5]);
          ctx.strokeStyle = strong ? "rgba(215,239,224,0.55)" : "rgba(122,154,134,0.35)";
          ctx.beginPath();
          ctx.moveTo(x0, yAt(z.top));
          ctx.lineTo(x1, yAt(z.top));
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = strong ? "rgba(215,239,224,0.85)" : MUTED;
          ctx.font = "8px ui-monospace, monospace";
          ctx.fillText(z.label, labelX(x1 - 28), yAt(z.top) - 3);
        }
        if (z.kind === "ote" && vis("ote")) {
          const x0 = xAt(z.t0);
          const x1 = Math.max(x0 + 8, xAt(z.t1));
          ctx.fillStyle = z.dir === 1 ? "rgba(61,255,138,0.08)" : "rgba(255,107,107,0.08)";
          ctx.fillRect(x0, yAt(z.top), x1 - x0, yAt(z.bot) - yAt(z.top));
          ctx.fillStyle = z.dir === 1 ? UP : DN;
          ctx.font = "8px ui-monospace, monospace";
          ctx.fillText(z.label, labelX(x0 + 4), yAt((z.top + z.bot) / 2) + 3);
        }
        if (z.kind === "grab" && vis("grab")) {
          const x0 = xAt(z.t0);
          const x1 = Math.max(x0 + 4, xAt(z.t1));
          ctx.fillStyle = z.dir === 1 ? "rgba(61,255,138,0.28)" : "rgba(255,107,107,0.28)";
          ctx.fillRect(x0 - 1, yAt(z.top), Math.max(6, x1 - x0 + 2), yAt(z.bot) - yAt(z.top));
          ctx.fillStyle = z.dir === 1 ? UP : DN;
          ctx.font = "8px ui-monospace, monospace";
          ctx.fillText(z.label, labelX(x0 + 2), yAt(z.dir === 1 ? z.bot : z.top) + (z.dir === 1 ? 10 : -2));
        }
        if (z.kind === "fvg" && vis("fvg")) {
          ctx.fillStyle = z.dir === 1 ? "rgba(61,255,138,0.16)" : "rgba(255,107,107,0.16)";
          const x0 = xAt(z.t0);
          const x1 = Math.max(x0 + 6, xAt(z.t1));
          ctx.fillRect(x0, yAt(z.top), x1 - x0, yAt(z.bot) - yAt(z.top));
          ctx.fillStyle = z.dir === 1 ? UP : DN;
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillText(z.label, labelX(x0 + 3), yAt((z.top + z.bot) / 2) + 3);
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
          ctx.fillText(z.label, labelX(x0 + 3), y0 + 11);
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
        const x1 = Math.min(w - pad.r - 2, xAt(z.t1));
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
        ctx.fillText(z.label, labelX(x1 - 22), y - 3);
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
        const price = mid + spanPx / 2 - (spanPx * g) / 4;
        ctx.fillStyle = MUTED;
        ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.fillText(px(price), w - pad.r + 4, y + 3);
      }

      ctx.fillStyle = MUTED;
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "center";
      for (let i = 0; i < view.length; i += Math.max(1, Math.ceil(view.length / 6))) {
        ctx.fillText(nyLabel(view[i]!.t), pad.l + (i + 0.5) * slot, h - 6);
      }
      ctx.textAlign = "left";

      if (view.length) {
        const i = hover ?? view.length - 1;
        const x = pad.l + (i + 0.5) * slot;
        ctx.strokeStyle = "rgba(215,239,224,0.25)";
        ctx.beginPath();
        ctx.moveTo(x, pad.t);
        ctx.lineTo(x, pad.t + innerH);
        ctx.stroke();
      }

      if (on.orders !== false && lastPx > 0) {
        const yLast = yAt(lastPx);
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = "rgba(215,239,224,0.55)";
        ctx.beginPath();
        ctx.moveTo(pad.l, yLast);
        ctx.lineTo(w - pad.r, yLast);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#d7efe0";
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText(`LAST ${px(lastPx)}`, w - pad.r + 4, clamp(yLast + 3, pad.t + 8, h - pad.b - 8));
      }

      if (on.orders !== false) {
        const xTime = (t: number) => {
          if (t <= view[0]!.t) return pad.l;
          if (t >= view[view.length - 1]!.t) return pad.l + innerW;
          return xAt(t);
        };
        const tag = (y: number, text: string, color: string, bg: string) => {
          const yy = clamp(y, pad.t + 8, h - pad.b - 8);
          ctx.fillStyle = bg;
          ctx.fillRect(w - pad.r + 2, yy - 8, pad.r - 6, 15);
          ctx.fillStyle = color;
          ctx.font = "9px ui-monospace, monospace";
          ctx.textAlign = "left";
          ctx.fillText(text, w - pad.r + 5, yy + 3);
        };
        for (const o of mine) {
          const x0 = xTime(o.openedAt);
          const x1 = o.closedAt ? xTime(o.closedAt) : pad.l + innerW;
          const yE = yAt(o.entry);
          ctx.setLineDash(o.pending ? [3, 3] : []);
          ctx.strokeStyle = o.side === "long" ? UP : DN;
          ctx.lineWidth = o.live ? 1.6 : 1;
          ctx.beginPath();
          ctx.moveTo(x0, yE);
          ctx.lineTo(x1, yE);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = o.side === "long" ? UP : DN;
          ctx.beginPath();
          if (o.side === "long") {
            ctx.moveTo(x0, yE + 8);
            ctx.lineTo(x0 - 5, yE);
            ctx.lineTo(x0 + 5, yE);
          } else {
            ctx.moveTo(x0, yE - 8);
            ctx.lineTo(x0 - 5, yE);
            ctx.lineTo(x0 + 5, yE);
          }
          ctx.closePath();
          ctx.fill();
          if (o.stop) {
            const yS = yAt(o.stop);
            ctx.setLineDash([5, 4]);
            ctx.strokeStyle = DN;
            ctx.beginPath();
            ctx.moveTo(x0, yS);
            ctx.lineTo(x1, yS);
            ctx.stroke();
            tag(yS, `SL ${px(o.stop)}`, DN, "rgba(255,107,107,0.18)");
          }
          if (o.target) {
            const yT = yAt(o.target);
            ctx.setLineDash([5, 4]);
            ctx.strokeStyle = UP;
            ctx.beginPath();
            ctx.moveTo(x0, yT);
            ctx.lineTo(x1, yT);
            ctx.stroke();
            tag(yT, `TP ${px(o.target)}`, UP, "rgba(61,255,138,0.16)");
          }
          ctx.setLineDash([]);
          const kind = o.pending ? `${o.side === "long" ? "BUY" : "SELL"} LMT` : o.live ? "ENTRY" : "FILL";
          tag(yE, `${kind} ${px(o.entry)}`, o.side === "long" ? UP : DN, "rgba(12,20,16,0.92)");
          if (o.exit && o.closedAt) {
            const yX = yAt(o.exit);
            const xX = xTime(o.closedAt);
            ctx.strokeStyle = o.reason === "stop" ? DN : UP;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(xX - 5, yX - 5);
            ctx.lineTo(xX + 5, yX + 5);
            ctx.moveTo(xX + 5, yX - 5);
            ctx.lineTo(xX - 5, yX + 5);
            ctx.stroke();
            tag(yX, `${(o.reason ?? "exit").toUpperCase()} ${px(o.exit)}`, o.reason === "stop" ? DN : UP, "rgba(12,20,16,0.92)");
          }
        }
      }
    };

    draw();
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [view, zones, on, hover, mine, lastPx]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;

    const barAt = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      const innerW = Math.max(1, rect.width - 58);
      const x = clientX - rect.left - 6;
      return clamp(Math.floor((x / innerW) * visN), 0, Math.max(0, visN - 1));
    };

    const onDown = (e: PointerEvent) => {
      drag.current.ids.set(e.pointerId, { x: e.clientX, y: e.clientY });
      drag.current.x = e.clientX;
      drag.current.start = visStart;
      drag.current.moved = false;
      drag.current.span0 = visN;
      if (drag.current.ids.size === 2) {
        const pts = [...drag.current.ids.values()];
        drag.current.pinch = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      }
      el.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      const rec = drag.current.ids.get(e.pointerId);
      if (rec) rec.x = e.clientX;
      if (rec) rec.y = e.clientY;

      if (drag.current.ids.size >= 2) {
        const pts = [...drag.current.ids.values()];
        const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
        if (drag.current.pinch && dist > 8) {
          const factor = drag.current.pinch / dist;
          const next = clamp(Math.round(drag.current.span0 * factor), 20, Math.max(20, nAll));
          const mid = visStart + visN / 2;
          setFollow(false);
          setSpan(next);
          setStart(clamp(Math.round(mid - next / 2), 0, Math.max(0, nAll - next)));
        }
        return;
      }

      if (!drag.current.ids.size) {
        setHover(barAt(e.clientX));
        return;
      }

      const dx = e.clientX - drag.current.x;
      if (Math.abs(dx) < 8 && !drag.current.moved) {
        setHover(barAt(e.clientX));
        return;
      }
      drag.current.moved = true;
      const rect = el.getBoundingClientRect();
      const slot = Math.max(4, (rect.width - 58) / visN);
      const bars = Math.round(dx / slot);
      setFollow(false);
      setStart(clamp(drag.current.start - bars, 0, Math.max(0, nAll - visN)));
    };

    const onUp = (e: PointerEvent) => {
      drag.current.ids.delete(e.pointerId);
      drag.current.pinch = null;
      if (!drag.current.ids.size && !drag.current.moved) setHover(barAt(e.clientX));
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const inward = e.deltaY < 0;
      const next = clamp(Math.round(visN * (inward ? 0.8 : 1.25)), 20, Math.max(20, nAll));
      const focus = visStart + barAt(e.clientX);
      const newStart = clamp(focus - Math.round((barAt(e.clientX) / visN) * next), 0, Math.max(0, nAll - next));
      setFollow(newStart + next >= nAll - 1);
      setSpan(next);
      setStart(newStart);
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, [visN, visStart, nAll]);

  const c = hover != null ? view[hover] : view[view.length - 1];
  const last = view[view.length - 1];
  const chg = last && view[0] ? (last.c - view[0]!.c) / view[0]!.c : 0;
  const working = mine.filter((o) => o.live);

  function zoom(factor: number) {
    const next = clamp(Math.round(visN * factor), 20, Math.max(20, nAll));
    const mid = visStart + visN / 2;
    setFollow(false);
    setSpan(next);
    setStart(clamp(Math.round(mid - next / 2), 0, Math.max(0, nAll - next)));
  }

  return (
    <div className={cn("flex h-full min-h-0 w-full min-w-0 max-w-full flex-col", fullscreen ? "h-full" : "")}>
      <div className="flex min-w-0 items-stretch">
        {onToggleFs && (
          <button
            type="button"
            className="m-2 h-8 shrink-0 rounded-md bg-phosphor px-3 font-mono text-[11px] tracking-[0.14em] text-phosphor-ink"
            onClick={onToggleFs}
          >
            {fullscreen ? "CLOSE" : "FULL"}
          </button>
        )}
        <ChipRow className="min-w-0 flex-1">
          {CHART_BARS.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => {
                setTf(b.id);
                setFollow(true);
              }}
              className={cn(
                "h-7 shrink-0 rounded px-2 font-mono text-[10px] tracking-[0.12em]",
                tf === b.id ? "bg-phosphor text-phosphor-ink" : "text-muted hover:text-fg",
              )}
            >
              {b.label}
            </button>
          ))}
        </ChipRow>
      </div>
      <ChipRow>
        {ICT_ASSETS.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => {
              setSym(a.id);
              setFollow(true);
            }}
            className={cn(
              "h-7 shrink-0 rounded px-2 font-mono text-[10px] tracking-[0.1em]",
              a.id === (book?.id ?? sym) ? "bg-phosphor text-phosphor-ink" : "text-muted hover:text-fg",
            )}
          >
            {a.symbol}
          </button>
        ))}
      </ChipRow>
      <ChipRow>
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
              "h-7 shrink-0 rounded px-2 font-mono text-[10px]",
              on[t.id] !== false ? "text-phosphor" : "text-subtle",
            )}
          >
            {t.label}
          </button>
        ))}
        <button type="button" className="h-7 shrink-0 rounded px-2 font-mono text-[10px] text-muted" onClick={() => zoom(0.75)}>
          +
        </button>
        <button type="button" className="h-7 shrink-0 rounded px-2 font-mono text-[10px] text-muted" onClick={() => zoom(1.35)}>
          −
        </button>
        <button
          type="button"
          className="h-7 shrink-0 rounded px-2 font-mono text-[10px] text-muted"
          onClick={() => {
            setFollow(false);
            setSpan(Math.max(20, nAll));
            setStart(0);
          }}
        >
          ALL
        </button>
        <button
          type="button"
          className="h-7 shrink-0 rounded px-2 font-mono text-[10px] text-phosphor"
          onClick={() => {
            setFollow(true);
            setSpan(tf === "1m" ? 80 : 72);
          }}
        >
          END
        </button>
      </ChipRow>
      <div className="flex min-w-0 flex-wrap items-baseline gap-3 px-3 pt-1 font-mono text-[11px] tabular">
        <span className="text-fg">{book?.symbol ?? sym}</span>
        <span className="text-subtle">{tf.toUpperCase()} · NY</span>
        {c && (
          <>
            <span className="text-subtle">O {px(c.o)}</span>
            <span className="text-phosphor">H {px(c.h)}</span>
            <span className="text-loss">L {px(c.l)}</span>
            <span className="text-fg">C {px(lastPx || c.c)}</span>
          </>
        )}
        <span className={chg >= 0 ? "text-phosphor" : "text-loss"}>
          {chg >= 0 ? "+" : ""}
          {(chg * 100).toFixed(2)}%
        </span>
        <span className="text-subtle">NY {c ? nyLabel(c.t) : "—"}</span>
        {tape.isFetching && <span className="text-muted">tick</span>}
        {stale && <span className="text-warn">stale tape</span>}
      </div>
      <div
        ref={wrap}
        className={cn(
          "relative min-w-0 touch-none",
          fullscreen ? "min-h-0 flex-1" : "h-[22rem] min-h-[18rem] md:h-[32rem]",
        )}
        style={{ touchAction: "none" }}
        onPointerLeave={() => setHover(null)}
      >
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
        {onToggleFs && (
          <button
            type="button"
            className="absolute right-2 top-2 z-20 h-9 rounded-md bg-phosphor px-3 font-mono text-[12px] tracking-[0.14em] text-phosphor-ink"
            onClick={onToggleFs}
          >
            {fullscreen ? "CLOSE" : "FULL"}
          </button>
        )}
      </div>
      <p className="px-3 pb-2 font-mono text-[10px] text-subtle">
        {working.length
          ? working
              .map((o) => {
                const kind = o.pending ? `${o.side === "long" ? "BUY LMT" : "SELL LMT"}` : `${o.side.toUpperCase()} ${o.setup}`;
                return `${kind}  EN ${px(o.entry)}  SL ${o.stop ? px(o.stop) : "—"}  TP ${o.target ? px(o.target) : "—"}`;
              })
              .join(" · ")
          : `no paper fill · boxes are levels · ${nextIctHint()}`}
      </p>
    </div>
  );
}
