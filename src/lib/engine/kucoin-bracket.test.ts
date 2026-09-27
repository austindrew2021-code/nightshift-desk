import assert from "node:assert/strict";
import test from "node:test";
import { ictBracket, positionIsFlat } from "./kucoin-live.ts";

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
test("short brackets are the mirror", () => {
  const { sl, tp } = ictBracket("short", "0.15", "0.16", 10);
  assert.equal(sl.stop, "up");
  assert.equal(sl.stopPrice, "0.16");
  assert.equal(tp.stop, "down");
  assert.equal(tp.stopPrice, "0.15");
  assert.equal(tp.side, "buy");
});
