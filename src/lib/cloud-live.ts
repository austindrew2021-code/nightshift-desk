import type { EngineState } from "@/lib/engine/session";

/** Tokyo Lightsail HTTPS (sslip.io). GitHub raw is a 5m-cache fallback. */
export const TOKYO_ORIGIN = "https://54-95-202-110.sslip.io";
export const GH_LIVE_ORIGIN =
  "https://raw.githubusercontent.com/austindrew2021-code/nightshift-desk/ict-live";

export const CLOUD_LIVE_URL = `${TOKYO_ORIGIN}/ict-state.json`;
export const CLOUD_KLINES_URL = `${TOKYO_ORIGIN}/ict-klines.json`;
export const CLOUD_LAST_URL = `${TOKYO_ORIGIN}/ict-last.json`;

export const CLOUD_FRESH_MS = 15 * 60_000;

export interface CloudLive {
  t: number;
  engine: EngineState;
}

export async function fetchLiveJson<T>(file: string): Promise<T | null> {
  const urls = [`${TOKYO_ORIGIN}/${file}`, `${GH_LIVE_ORIGIN}/${file}`];
  for (const u of urls) {
    try {
      const res = await fetch(`${u}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) continue;
      return (await res.json()) as T;
    } catch {
      /* try next origin */
    }
  }
  return null;
}

export async function fetchCloudLive(): Promise<CloudLive | null> {
  const j = await fetchLiveJson<CloudLive>("ict-state.json");
  if (!j?.t || !j.engine || j.engine.mode !== "ict") return null;
  return j;
}

export function cloudIsFresh(t: number, now = Date.now()) {
  return t > 0 && now - t < CLOUD_FRESH_MS;
}
