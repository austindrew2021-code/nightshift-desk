import { test } from "node:test";
import assert from "node:assert/strict";
import { liqDistance, maxSafeLeverage, ticket, simultaneousRisk, DEFAULT_MMR } from "./sizing.ts";

test("liquidation distance shrinks as leverage rises", () => {
  assert.ok(liqDistance(10) > liqDistance(20));
  assert.ok(liqDistance(20) > liqDistance(40));
  // 40x with 0.5% maintenance = 2% adverse
  assert.ok(Math.abs(liqDistance(40, 0.005) - 0.02) < 1e-9);
  assert.equal(liqDistance(0), 0, "zero leverage must not divide by zero");
});

test("maxSafeLeverage keeps liquidation the required multiple beyond the stop", () => {
  for (const stop of [0.005, 0.01, 0.02, 0.028, 0.04]) {
    const lev = maxSafeLeverage(stop, 1.5);
    const liq = liqDistance(lev, DEFAULT_MMR);
    assert.ok(
      liq >= stop * 1.5 - 1e-9,
      `at ${lev.toFixed(1)}x, liq ${(liq * 100).toFixed(2)}% is not 1.5x beyond stop ${(stop * 100).toFixed(2)}%`,
    );
  }
});

test("the XRP ticket that 'would not size' at 40x sizes fine at 21x", () => {
  // stop above the 1.46 wick was ~2.8% from entry
  const t = ticket({ workingCashUsd: 100, riskPct: 0.18, stopPct: 0.028, maxLeverage: 40 });
  assert.ok(t.ok, `should be takeable: ${t.reason}`);
  assert.ok(t.leverage <= 22 && t.leverage >= 20, `expected ~21x, got ${t.leverage}x`);
  assert.ok(t.liqPct > 0.028, "liquidation must sit beyond the stop");
  assert.ok(t.liqOverStop >= 1.5 - 1e-9, `liq/stop ${t.liqOverStop.toFixed(2)} below safety`);
  // Risk is what it should be; notional falls out of risk / stop.
  assert.ok(Math.abs(t.riskUsd - 18) < 1e-9);
  assert.ok(Math.abs(t.notionalUsd - 18 / 0.028) < 1e-6);
});

test("notional is set by risk and stop, never by leverage", () => {
  // Same risk and same stop at two leverage caps: identical position size, only
  // the margin locked up differs. Sized so both stay inside the margin cap.
  const a = ticket({ workingCashUsd: 100, riskPct: 0.02, stopPct: 0.02, maxLeverage: 40 });
  const b = ticket({ workingCashUsd: 100, riskPct: 0.02, stopPct: 0.02, maxLeverage: 10 });
  assert.ok(a.ok && b.ok, `${a.reason} | ${b.reason}`);
  assert.ok(
    Math.abs(a.notionalUsd - b.notionalUsd) < 1e-6,
    "changing the leverage cap must not change position size",
  );
  assert.ok(b.marginUsd > a.marginUsd, "lower leverage locks up more margin for the same size");
});

test("the margin cap DOES bind at high risk on a small account", () => {
  // The nuance to the rule above: notional = risk / stop, so 18% risk on a
  // 1% stop is $1,800 of notional on a $100 book. At 10x that needs $180 of
  // margin, far past the 50% cap, so it is refused rather than silently
  // shrunk. Leverage does not set size, but the margin you can afford caps it.
  const low = ticket({ workingCashUsd: 100, riskPct: 0.18, stopPct: 0.01, maxLeverage: 10 });
  assert.equal(low.ok, false);
  assert.match(low.reason, /margin|cap/);
  const high = ticket({ workingCashUsd: 100, riskPct: 0.18, stopPct: 0.01, maxLeverage: 40 });
  assert.ok(high.ok, high.reason);
  assert.ok(high.marginUsd <= 50 + 1e-9);
});

test("a stop too wide to survive is refused rather than silently resized", () => {
  const t = ticket({ workingCashUsd: 100, riskPct: 0.18, stopPct: 0.9, maxLeverage: 40 });
  assert.equal(t.ok, false);
  assert.match(t.reason, /too wide/);
});

test("the margin cap refuses a ticket instead of over-committing the book", () => {
  // Tiny stop -> huge notional -> margin blows the 50% cap even at max leverage.
  const t = ticket({ workingCashUsd: 100, riskPct: 0.5, stopPct: 0.0008, maxLeverage: 5 });
  assert.equal(t.ok, false);
  assert.match(t.reason, /margin|cap/);
});

test("NPC's 20x venue ceiling is respected even when a higher leverage is safe", () => {
  // A 0.4% stop would be safe at 80x, but NPC caps at 20x on KuCoin.
  const t = ticket({ workingCashUsd: 100, riskPct: 0.02, stopPct: 0.004, maxLeverage: 20 });
  assert.ok(t.ok, t.reason);
  assert.ok(t.leverage <= 20, `venue cap breached: ${t.leverage}x`);
  assert.ok(maxSafeLeverage(0.004, 1.5) > 20, "the cap, not safety, should be binding here");
});

test("simultaneous risk reports the correlated worst case, not the naive sum", () => {
  const s = simultaneousRisk({ riskPct: 0.18, openPositions: 5, sameSideMax: 2 });
  assert.ok(Math.abs(s.worstCasePct - 0.9) < 1e-9, "5 x 18% is 90% if they stop together");
  assert.ok(s.effectivePct > 0.5, "correlated crypto does not diversify this away");
  assert.ok(s.effectivePct <= s.worstCasePct + 1e-9);
});

test("zero and negative inputs never produce a tradeable ticket", () => {
  for (const o of [
    { workingCashUsd: 0, riskPct: 0.18, stopPct: 0.01, maxLeverage: 40 },
    { workingCashUsd: 100, riskPct: 0.18, stopPct: 0, maxLeverage: 40 },
    { workingCashUsd: 100, riskPct: 0.18, stopPct: -0.01, maxLeverage: 40 },
  ]) {
    assert.equal(ticket(o).ok, false, JSON.stringify(o));
  }
});
