import assert from "node:assert/strict";
import test from "node:test";
import { ictBracket, levInsideStop, orderPastMark, positionIsFlat, realLiqPct, entryLimitPx } from "./kucoin-live.ts";

test("long 1R sell sits above and the stop sits below, neither locks the position", () => {
  const { sl, tp } = ictBracket("long", "10.924", "10.746", 64);
  assert.equal(sl.stop, "down");
  assert.equal(sl.stopPrice, "10.746");
  assert.equal(tp.stop, "up");
  assert.equal(tp.stopPrice, "10.924");
  assert.equal(sl.side, "sell");
  assert.equal(tp.side, "sell");
  assert.equal(sl.size, 64);
  assert.equal(tp.size, 64);
  assert.equal(sl.reduceOnly, true);
  assert.equal(tp.reduceOnly, true);
  assert.equal("closeOrder" in sl, false);
  assert.equal("closeOrder" in tp, false);
  assert.equal("postOnly" in tp, false);
});

test("a missing symbol is not a flat position", () => {
  const open = new Map([["AVAXUSDTM", 64]]);
  assert.equal(positionIsFlat(open, "AVAXUSDTM", 20_000), false);
  assert.equal(positionIsFlat(new Map(), "AVAXUSDTM", 20_000), false);
  assert.equal(positionIsFlat(null, "AVAXUSDTM", 20_000), false);
  assert.equal(positionIsFlat(new Map([["AVAXUSDTM", 0]]), "AVAXUSDTM", 20_000), true);
  assert.equal(positionIsFlat(new Map([["AVAXUSDTM", 0]]), "AVAXUSDTM", 3_000), false);
  const short = new Map([["AVAXUSDTM", -64]]);
  assert.equal(positionIsFlat(short, "AVAXUSDTM", 20_000), false);
});
test("ONE at the 4am price is not sent once the futures price has left", () => {
  assert.equal(orderPastMark("long", 0.00258991, 0.00248, 0.000052, 30), true);
  assert.equal(orderPastMark("short", 0.24595, 0.245, 0.00495, 30), false);
  assert.equal(orderPastMark("long", 10.835, 10.83, 0.089, 40), false);
  assert.equal(orderPastMark("long", 0.00258991, 0, 0.000052, 30), false);
  assert.equal(orderPastMark("short", 0.24595, 0.2464, 0.00495, 30), false);
});
test("a valid long still fills after the cap and dies at 0.5R", () => {
  const under = entryLimitPx("long", 100, 100.1, 1, 0.01);
  assert.equal(under?.chase, false);
  assert.equal(under?.px, 100.2);
  const through = entryLimitPx("long", 100, 100.3, 1, 0.01);
  assert.equal(through?.chase, true);
  assert.ok(through && through.px >= 100.3);
  assert.equal(entryLimitPx("long", 100, 100.5, 1, 0.01), null);
  const fade = entryLimitPx("short", 100, 99.7, 1, 0.01);
  assert.equal(fade?.chase, true);
  assert.ok(fade && fade.px <= 99.7);
});
test("short brackets are the mirror", () => {
  const { sl, tp } = ictBracket("short", "0.15", "0.16", 10);
  assert.equal(sl.stop, "up");
  assert.equal(sl.stopPrice, "0.16");
  assert.equal(tp.stop, "down");
  assert.equal(tp.stopPrice, "0.15");
  assert.equal(tp.side, "buy");
});
test("KAS maintenance drops 40x so the wick stop is inside the real liquidation", () => {
  const stopPct = (0.045919 - 0.045074) / 0.045919;
  const mmr = 0.012;
  const lev = levInsideStop(stopPct, mmr, 50, 40);
  assert.equal(lev, 30);
  const liq = 0.045919 * (1 - realLiqPct(lev, mmr));
  assert.ok(liq < 0.045074);
  assert.equal(levInsideStop(0.018, 0.004, 125, 40), 40);
});
