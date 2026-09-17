import assert from "node:assert/strict";
import { test } from "node:test";
import { scanPlayback } from "./ict.ts";
import type { Candle } from "./types.ts";

/** NY 10:00 + n 5m bars. Killzone = Silver/NY AM. */
function ny(minFromTen: number): number {
  // 2026-09-17 14:00 UTC = 10:00 NY EDT
  return Date.UTC(2026, 8, 17, 14, 0, 0) + minFromTen * 60_000;
}

function c(i: number, o: number, h: number, l: number, close: number): Candle {
  return { t: ny(i * 5), o, h, l, c: close, v: 1 };
}

test("playback shorts a double top inside a Bear OB after CISD", () => {
  const cs: Candle[] = [];
  // Warmup grind
  for (let i = 0; i < 40; i++) {
    const px = 0.35 + i * 0.0004;
    cs.push(c(i, px, px + 0.0006, px - 0.0004, px + 0.0003));
  }
  // Last up candle = Bear OB body ~0.370-0.372
  cs.push(c(40, 0.369, 0.3724, 0.3688, 0.372));
  // Displacement down that prints the Bear OB
  cs.push(c(41, 0.3715, 0.3722, 0.365, 0.3655));
  cs.push(c(42, 0.3655, 0.3668, 0.3648, 0.366));
  // Rally to first top into the OB
  cs.push(c(43, 0.3662, 0.3718, 0.366, 0.3712));
  cs.push(c(44, 0.371, 0.3716, 0.3685, 0.369));
  // Second top, equal high, close back inside
  cs.push(c(45, 0.3692, 0.3722, 0.3688, 0.3704));
  cs.push(c(46, 0.3702, 0.371, 0.368, 0.3684));
  // CISD down through the series low of the second tap
  cs.push(c(47, 0.368, 0.3686, 0.3618, 0.3622));

  const sigs = scanPlayback(cs);
  const shorts = sigs.filter((s) => s.side === "short" && s.note.includes("Playback"));
  assert.ok(shorts.length >= 1, `expected a playback short, got ${sigs.map((s) => s.note).join(" | ") || "none"}`);
  const s = shorts[0]!;
  assert.equal(s.setup, "sweep");
  assert.ok(s.stop > s.entry, "short stop above entry");
  assert.ok(s.target < s.entry, "short target below entry");
  assert.ok(s.note.includes("DT Bear OB"));
});
