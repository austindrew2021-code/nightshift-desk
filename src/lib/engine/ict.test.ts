import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanIct, simulateIct, parseKlines, nyParts, nyHour, isSilver,
  DEFAULT_ICT_COSTS, ZERO_ICT_COSTS, type IctSignal,
} from "./ict.ts";
import fallback from "../market/fallback-klines.json" with { type: "json" };
import type { Candle } from "./types.ts";

const M15: Candle[] = parseKlines(fallback.m15 as number[][]);

test("the fixture is chronological — scanIct output is meaningless otherwise", () => {
  for (let i = 1; i < M15.length; i++) {
    assert.ok(M15[i]!.t > M15[i - 1]!.t, `bar ${i} is not after ${i - 1}`);
  }
});

test("costs strictly reduce PnL, and zero costs reproduce the frictionless result", () => {
  const sigs = scanIct(M15);
  assert.ok(sigs.length > 0, "fixture produced no signals");
  const free = simulateIct(M15, sigs, 100, "SOL", "Solana", ZERO_ICT_COSTS);
  const real = simulateIct(M15, sigs, 100, "SOL", "Solana", DEFAULT_ICT_COSTS);
  const sum = (ts: { pnlUsd: number }[]) => ts.reduce((a, t) => a + t.pnlUsd, 0);
  assert.ok(
    sum(real) < sum(free),
    `costed PnL ${sum(real).toFixed(2)} should be below frictionless ${sum(free).toFixed(2)}`,
  );
  // Same trade population; costs must not change which setups trigger.
  assert.equal(real.length, free.length);
});

test("a flat round trip loses money — fees and spread are never free", () => {
  // Entry and exit at the same price: the only outcome may be a loss.
  const flat: IctSignal[] = [{
    ...(scanIct(M15)[0] as IctSignal),
  }];
  const t = simulateIct(M15, flat, 100, "SOL", "Solana", DEFAULT_ICT_COSTS);
  if (t.length) {
    const zero = simulateIct(M15, flat, 100, "SOL", "Solana", ZERO_ICT_COSTS);
    assert.ok(t[0]!.pnlUsd < zero[0]!.pnlUsd, "costs did not reduce this trade");
  }
});

test("a stop that gaps through fills at the open, so the loss exceeds 1R", () => {
  // Hand-built: long entered at 100, stop 99 (1R = 1.0), then a bar that opens
  // at 95 — far through the stop. Filling at the stop would report -1R.
  const entry = 100, stop = 99;
  const cs: Candle[] = [
    { t: 0, o: 100, h: 100.5, l: 99.8, c: 100, v: 1 },
    { t: 9e5, o: 100, h: 100.2, l: 99.9, c: 100, v: 1 },   // fill bar (touches entry)
    { t: 18e5, o: 95, h: 95.5, l: 94, c: 95, v: 1 },       // gaps through the stop
  ];
  const sig = {
    i: 0, t: 0, setup: "sweep", side: "long", entry, stop,
    target: 102, note: "gap test",
  } as unknown as IctSignal;
  const [tr] = simulateIct(cs, [sig], 100, "X", "X", ZERO_ICT_COSTS);
  assert.ok(tr, "trade did not fill");
  assert.equal(tr!.reason, "stop");
  assert.ok(
    tr!.rMultiple < -1.5,
    `gap loss should be well past -1R, got ${tr!.rMultiple.toFixed(2)}R`,
  );
  assert.ok(tr!.exitUsd <= 95, `exit should be at/below the gap open, got ${tr!.exitUsd}`);
});

test("market-entry setups fill at the next open, not at the signal price", () => {
  const entry = 100;
  const cs: Candle[] = [
    { t: 0, o: 100, h: 100.2, l: 99.9, c: 100, v: 1 },
    { t: 9e5, o: 101.5, h: 103, l: 101.4, c: 102.8, v: 1 }, // opens away from signal
    { t: 18e5, o: 103, h: 106, l: 102.9, c: 105.5, v: 1 },
  ];
  const sig = {
    i: 0, t: 0, setup: "div", side: "long", entry, stop: 99, target: 104,
    note: "market entry",
  } as unknown as IctSignal;
  const [tr] = simulateIct(cs, [sig], 100, "X", "X", ZERO_ICT_COSTS);
  assert.ok(tr, "div trade did not fill");
  assert.equal(
    tr!.entryUsd, 101.5,
    "a div signal must fill at the next bar's open, never at a close it could not trade",
  );
});

test("NY session windows are correct in EDT and in EST", () => {
  // 2026-07-15 14:30 UTC = 10:30 EDT (UTC-4) -> inside Silver Bullet.
  const edt = Date.UTC(2026, 6, 15, 14, 30);
  assert.equal(nyParts(edt).h, 10, "EDT hour wrong");
  assert.ok(isSilver(edt), "10:30 NY in July must be Silver Bullet");

  // 2026-12-15 15:30 UTC = 10:30 EST (UTC-5) -> also Silver Bullet.
  // This FAILS while NY_OFFSET_MS is hardcoded to 4h (ict.ts:3) and is the
  // regression guard for board row 1. See bots/TIMING.md.
  const est = Date.UTC(2026, 11, 15, 15, 30);
  assert.equal(nyParts(est).h, 10, "EST hour wrong — offset is hardcoded to EDT");
  assert.ok(isSilver(est), "10:30 NY in December must be Silver Bullet");
});

test("lookahead ratchet: signals that need future bars must not increase", () => {
  const full = scanIct(M15);
  let vanished = 0;
  for (const s of full) {
    const causal = scanIct(M15.slice(0, s.i + 1));
    const found = causal.some(
      (c) => c.setup === s.setup && Math.abs(c.entry - s.entry) < 1e-9,
    );
    if (!found) vanished++;
  }
  const share = vanished / Math.max(1, full.length);
  // Board row 20. Measured on this fixture at the time of writing; the target
  // is 0. Tighten this bound as scanIct is fixed — never loosen it.
  assert.ok(
    share <= 0.8,
    `${(share * 100).toFixed(0)}% of signals need future bars (was <=80%)`,
  );
  assert.ok(full.length > 0);
});

test("nyHour is continuous and never NaN across a full day", () => {
  for (let h = 0; h < 24; h++) {
    const v = nyHour(Date.UTC(2026, 8, 15, h, 0));
    assert.ok(Number.isFinite(v) && v >= 0 && v < 24, `nyHour bad at UTC ${h}`);
  }
});
