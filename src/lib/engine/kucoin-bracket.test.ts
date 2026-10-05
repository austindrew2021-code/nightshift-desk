import assert from "node:assert/strict";
import test from "node:test";
import { alreadyLeft, entryWindow, ictBracket, keepWorkingExit, levInsideStop, orderPastMark, positionIsFlat, realLiqPct } from "./kucoin-live.ts";

test("long target is a resting limit and the stop stays a stop-market", () => {
  const { sl, tp, tpStop } = ictBracket("long", "10.924", "10.746", 64);
  assert.equal(sl.stop, "down");
  assert.equal(sl.stopPrice, "10.746");
  assert.equal(sl.type, "market");
  assert.equal(tp.type, "limit");
  assert.equal(tp.price, "10.924");
  assert.equal(tp.postOnly, true);
  assert.equal(tp.timeInForce, "GTC");
  assert.equal("stop" in tp, false);
  assert.equal(tpStop.stop, "up");
  assert.equal(tpStop.stopPrice, "10.924");
  assert.equal(sl.side, "sell");
  assert.equal(tp.side, "sell");
  assert.equal(sl.size, 64);
  assert.equal(tp.size, 64);
  assert.equal(sl.reduceOnly, true);
  assert.equal(tp.reduceOnly, true);
  assert.equal("closeOrder" in sl, false);
  assert.equal("closeOrder" in tp, false);
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
test("a price already 0.05R through is not a pullback entry", () => {
  assert.equal(alreadyLeft("long", 1, 1.04, 1), false);
  assert.equal(alreadyLeft("long", 1, 1.06, 1), true);
  assert.equal(alreadyLeft("short", 1, 0.96, 1), false);
  assert.equal(alreadyLeft("short", 1, 0.94, 1), true);
  assert.equal(alreadyLeft("long", 10, 9.9, 1), false);
  assert.equal(alreadyLeft("long", 1, 0, 1), false);
});
test("the candle close and the ticker are one decision", () => {
  assert.equal(entryWindow("long", 1, 1.03, 1.04, 1), "take");
  assert.equal(entryWindow("long", 1, 1.02, 1.06, 1), "late");
  assert.equal(entryWindow("long", 1, 1.02, 1.25, 1), "late");
  assert.equal(entryWindow("long", 1, 1.08, 1.08, 1), "left");
  assert.equal(entryWindow("short", 1, 0.99, 0.7, 1), "late");
  assert.equal(entryWindow("long", 1, 0, 1.02, 1), "take");
});
test("ONE at the 4am price is not sent once the futures price has left", () => {
  assert.equal(orderPastMark("long", 0.00258991, 0.00248, 0.000052, 30), true);
  assert.equal(orderPastMark("short", 0.24595, 0.245, 0.00495, 30), false);
  assert.equal(orderPastMark("long", 10.835, 10.83, 0.089, 40), false);
  assert.equal(orderPastMark("long", 0.00258991, 0, 0.000052, 30), false);
  assert.equal(orderPastMark("short", 0.24595, 0.2464, 0.00495, 30), false);
});
test("short brackets are the mirror", () => {
  const { sl, tp, tpStop } = ictBracket("short", "0.15", "0.16", 10);
  assert.equal(sl.stop, "up");
  assert.equal(sl.stopPrice, "0.16");
  assert.equal(tp.type, "limit");
  assert.equal(tp.price, "0.15");
  assert.equal(tp.side, "buy");
  assert.equal(tpStop.stop, "down");
  assert.equal(tpStop.stopPrice, "0.15");
});
test("a working target is not cancelled to sell the pullback", () => {
  assert.equal(keepWorkingExit("target", true, true, 26), true);
  assert.equal(keepWorkingExit("target", true, false, 26), true);
  assert.equal(keepWorkingExit("stop", false, true, 26), true);
  assert.equal(keepWorkingExit("time", true, true, 26), false);
  assert.equal(keepWorkingExit("target", false, false, 26), false);
  assert.equal(keepWorkingExit("target", true, true, 0), false);
  assert.equal(keepWorkingExit("target", true, true, -1), true);
  assert.equal(keepWorkingExit("time", true, true, -1), false);
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
