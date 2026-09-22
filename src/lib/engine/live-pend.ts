import type { Position } from "./types";

/** Opens this tick. Worker live-sync reads it after markIct may have closed the seat. */
export const ictLivePend: Position[] = [];

export function queueLiveOpen(p: Position) {
  ictLivePend.push(p);
}
