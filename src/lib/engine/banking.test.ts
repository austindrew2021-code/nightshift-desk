import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_BANK, fixedStep, ratchet, atMultiples, stakeFirst, POLICIES,
  applyBanking, type BankState,
} from "./banking.ts";

const fresh = (cash = 100, banked = 0, peak = 100, start = 100): BankState =>
  ({ cash, banked, peak, start });

test("no policy ever creates or destroys money", () => {
  for (const p of POLICIES) {
    const s = fresh(250, 0, 180);
    const before = s.cash + s.banked;
    applyBanking(s, p);
    assert.ok(
      Math.abs(s.cash + s.banked - before) < 1e-9,
      `${p.id} changed total equity from ${before} to ${s.cash + s.banked}`,
    );
  }
});

test("no policy ever banks more cash than exists, or a negative amount", () => {
  for (const p of POLICIES) {
    for (const [cash, banked, peak] of [[100, 0, 100], [12, 300, 500], [1000, 0, 100], [0.4, 50, 200]]) {
      const s = fresh(cash, banked, peak);
      applyBanking(s, p);
      assert.ok(s.cash >= -1e-9, `${p.id} drove cash negative: ${s.cash}`);
      assert.ok(s.banked >= banked - 1e-9, `${p.id} un-banked money`);
    }
  }
});

test("banking never runs on a losing account", () => {
  for (const p of POLICIES) {
    const s = fresh(60, 0, 100);      // down 40%
    const before = s.banked;
    applyBanking(s, p);
    assert.equal(s.banked, before, `${p.id} banked while underwater`);
  }
});

test("NO_BANK is inert", () => {
  const s = fresh(900, 0, 400);
  applyBanking(s, NO_BANK);
  assert.equal(s.banked, 0);
  assert.equal(s.cash, 900);
});

test("fixedStep vaults 50% of each whole $100 gained", () => {
  const p = fixedStep(100, 0.5);
  const s = fresh(250);              // +$150 lifetime -> one whole step -> $50
  applyBanking(s, p);
  assert.equal(s.banked, 50);
  assert.equal(s.cash, 200);
  // A second step at +$250 lifetime should top the vault to $100 total.
  const s2 = fresh(300, 50, 250);
  applyBanking(s2, p);
  assert.equal(s2.banked, 100);
});

test("ratchet banks a share of the new high only, and nothing at a flat peak", () => {
  const p = ratchet(0.5, 0.5);
  const s = fresh(200, 0, 150);      // equity 200, peak 150 -> new high of 50
  applyBanking(s, p);
  assert.equal(s.banked, 25, "should bank half of the 50 of new high");
  // At exactly the peak there is no new high.
  const flat = fresh(150, 0, 150);
  applyBanking(flat, p);
  assert.equal(flat.banked, 0);
});

test("ratchet respects the floor and will not strip the book", () => {
  // Equity far above peak but almost all of it already vaulted: floor is 50% of
  // start ($50), and cash is $55, so at most $5 may move.
  const s = fresh(55, 400, 100);
  applyBanking(s, ratchet(1.0, 0.5));
  assert.ok(s.cash >= 50 - 1e-9, `floor breached, cash ${s.cash}`);
  assert.ok(s.banked <= 405 + 1e-9);
});

test("atMultiples banks at 2x and holds until the next multiple", () => {
  const p = atMultiples([2, 3, 5], 0.5, 0.5);
  const at2 = fresh(200, 0, 200);
  applyBanking(at2, p);
  assert.equal(at2.banked, 50, "2x should vault 50% of the 1x gain");
  // Still between 2x and 3x: no further banking.
  const between = fresh(200, 50, 250);
  applyBanking(between, p);
  assert.equal(between.banked, 50);
});

test("stakeFirst makes the original stake safe at 2x before ratcheting", () => {
  const p = stakeFirst(0.3);
  const s = fresh(200, 0, 200);
  applyBanking(s, p);
  assert.equal(s.banked, 100, "the whole $100 stake should be vaulted at 2x");
  assert.equal(s.cash, 100);
  // Below 2x it does nothing at all.
  const below = fresh(150, 0, 150);
  applyBanking(below, p);
  assert.equal(below.banked, 0);
});

test("a vaulted dollar is never exposed again", () => {
  // Bank on the way up, then lose the entire trading book: the vault survives.
  const p = ratchet(0.6, 0.5);
  const s = fresh(100, 0, 100);
  for (const eq of [140, 190, 260, 350]) {
    s.cash = eq - s.banked;
    applyBanking(s, p);
  }
  const vault = s.banked;
  assert.ok(vault > 0, "nothing was banked across a 3.5x run");
  s.cash = 0;                        // book wiped out
  assert.equal(s.banked, vault, "vault moved when the book was wiped");
});
