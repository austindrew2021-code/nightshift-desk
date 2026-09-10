import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getDeskSnapshot } from "@/lib/market/api";
import { useDesk } from "@/lib/store";

export function DeskRuntime({ children }: { children: ReactNode }) {
  const hydrate = useDesk((s) => s.hydrateMarket);
  const setError = useDesk((s) => s.setMarketError);
  const setStartUsd = useDesk((s) => s.setStartUsd);
  const step = useDesk((s) => s.step);
  const running = useDesk((s) => s.engine.running);
  const speed = useDesk((s) => s.engine.speed);
  const mode = useDesk((s) => s.engine.mode);
  const play = useDesk((s) => s.play);

  const q = useQuery({
    queryKey: ["desk-snapshot"],
    queryFn: () => getDeskSnapshot(),
    refetchInterval: mode === "live" ? 12_000 : 45_000,
  });

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("nightshift.startUsd");
      if (raw == null || raw === "") return;
      const n = Number(raw);
      const cur = useDesk.getState().engine.startUsd;
      if (Number.isFinite(n) && Math.round(n) !== Math.round(cur)) setStartUsd(n);
    } catch {
      /* ignore */
    }
  }, [setStartUsd]);

  useEffect(() => {
    if (q.data) hydrate(q.data);
  }, [q.data, hydrate]);

  useEffect(() => {
    if (q.error) setError(q.error instanceof Error ? q.error.message : "market feed failed");
  }, [q.error, setError]);

  useEffect(() => {
    if (!running) return;
    const ms = Math.max(70, 480 / Math.max(1, speed));
    const id = window.setInterval(() => step(), ms);
    return () => window.clearInterval(id);
  }, [running, speed, step]);

  useEffect(() => {
    const t = window.setTimeout(() => play(), 400);
    return () => window.clearTimeout(t);
  }, [play]);

  return children;
}