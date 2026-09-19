import type { EngineState } from "@/lib/engine/session";

export const CLOUD_LIVE_URL =
  "https://raw.githubusercontent.com/austindrew2021-code/nightshift-desk/ict-live/ict-state.json";

export const CLOUD_KLINES_URL =
  "https://raw.githubusercontent.com/austindrew2021-code/nightshift-desk/ict-live/ict-klines.json";

export const CLOUD_LAST_URL =
  "https://raw.githubusercontent.com/austindrew2021-code/nightshift-desk/ict-live/ict-last.json";

export const CLOUD_FRESH_MS = 15 * 60_000;

export interface CloudLive {
  t: number;
  engine: EngineState;
}

export async function fetchCloudLive(): Promise<CloudLive | null> {
  try {
    const res = await fetch(`${CLOUD_LIVE_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as CloudLive;
    if (!j?.t || !j.engine || j.engine.mode !== "ict") return null;
    return j;
  } catch {
    return null;
  }
}

export function cloudIsFresh(t: number, now = Date.now()) {
  return t > 0 && now - t < CLOUD_FRESH_MS;
}