import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getDeskSnapshot, getIctBooks, getMintQuotes } from "@/lib/market/api";
import { useDesk } from "@/lib/store";
import { loadEngine } from "@/lib/persist";

export function DeskRuntime({ children }: { children: ReactNode }) {
  const hydrate = useDesk((s) => s.hydrateMarket);
  const hydrateQuotes = useDesk((s) => s.hydrateQuotes);
  const hydrateBooks = useDesk((s) => s.hydrateBooks);
  const restoreSession = useDesk((s) => s.restoreSession);
  const persistNow = useDesk((s) => s.persistNow);
  const setError = useDesk((s) => s.setMarketError);
  const step = useDesk((s) => s.step);
  const running = useDesk((s) => s.engine.running);
  const speed = useDesk((s) => s.engine.speed);
  const mode = useDesk((s) => s.engine.mode);
  const openMints = useDesk((s) =>
    s.engine.open.filter((p) => p.origin === "live").map((p) => p.mint).join(","),
  );
  const play = useDesk((s) => s.play);

  const q = useQuery({
    queryKey: ["desk-snapshot"],
    queryFn: () => getDeskSnapshot(),
    refetchInterval: mode === "live" ? 8_000 : mode === "ict" ? 12_000 : 45_000,
  });

  const quotes = useQuery({
    queryKey: ["mint-quotes", openMints],
    queryFn: () => getMintQuotes({ data: { mints: openMints.split(",").filter(Boolean) } }),
    enabled: Boolean(openMints) && (mode === "live" || mode === "watch"),
    refetchInterval: 8_000,
  });

  const books = useQuery({
    queryKey: ["ict-books"],
    queryFn: () => getIctBooks(),
    refetchInterval: mode === "ict" ? 5_000 : 60_000,
    staleTime: 2_000,
  });

  useLayoutEffect(() => {
    const saved = loadEngine();
    if (saved) restoreSession(saved);
  }, [restoreSession]);

  useEffect(() => {
    const save = () => persistNow();
    const id = window.setInterval(save, 2500);
    const onHide = () => {
      if (document.visibilityState === "hidden") save();
    };
    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", save);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("pagehide", save);
      window.removeEventListener("beforeunload", save);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [persistNow]);

  useEffect(() => {
    if (!running || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let dead = false;
    const grab = async () => {
      try {
        lock = await navigator.wakeLock.request("screen");
      } catch {
        /* denied / unsupported */
      }
    };
    void grab();
    const onVis = () => {
      if (!dead && document.visibilityState === "visible") void grab();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      dead = true;
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release();
    };
  }, [running]);

  useEffect(() => {
    if (q.data) hydrate(q.data);
  }, [q.data, hydrate]);

  useEffect(() => {
    if (quotes.data) hydrateQuotes(quotes.data);
  }, [quotes.data, hydrateQuotes]);

  useEffect(() => {
    if (books.data) hydrateBooks(books.data);
  }, [books.data, hydrateBooks]);

  useEffect(() => {
    if (q.error) setError(q.error instanceof Error ? q.error.message : "market feed failed");
  }, [q.error, setError]);

  useEffect(() => {
    if (!running) return;
    const ms = mode === "live" || mode === "ict" ? 1000 : Math.max(70, 480 / Math.max(1, speed));
    const id = window.setInterval(() => step(), ms);
    return () => window.clearInterval(id);
  }, [running, speed, step, mode]);

  useEffect(() => {
    const t = window.setTimeout(() => play(), 400);
    return () => window.clearTimeout(t);
  }, [play]);

  return children;
}