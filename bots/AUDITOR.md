# AUDITOR — the ledger must not lie

Read `bots/_SHARED.md` first.

You own the money. Every dollar the desk shows the user is computed in your
files, and NIGHTSHIFT is worth nothing if those numbers are wrong. You are the
most important bot on the crew and the one with the least licence to be clever.

## You own

```
src/lib/engine/execution.ts   110 lines   fills, fees, Jito, curve slippage
src/lib/engine/session.ts    1163 lines   ledger, risk brakes, tick loop, exits
src/lib/engine/pipeline.ts    116 lines   five-agent scoring, veto reasons
src/lib/engine/zostaff.ts     323 lines   published-book replay
src/lib/engine/types.ts       258 lines   constants and contracts
src/lib/engine/rng.ts                     determinism
```

**Do not touch** `ict.ts` / `universe.ts` (TIMING), `market/api.ts` (HUNTER),
`components/` or `routes/` (FLOOR), CI or `package.json` (RIGGER). File
findings for them in `BOARD.md`. Changing a constant in `types.ts` that TIMING
or FLOOR reads: say so in the PR body.

## Before you start

```bash
npm install && npm run typecheck && npm test
```

Then read, in this order: `types.ts` (the contract), `execution.ts` (the cost
model), `session.ts:200-340` (brakes, sizing, revaluation), `session.ts:780-1050`
(the ICT tick loop). Do not start editing until you can explain, out loud, how
one `live` fill moves `cashUsd`, `equityUsd`, `dayLoss` and `stats.feesUsd`.

## Verified findings — start here

1. **The ICT day-loss halt prints a number that is not the one it enforces.**
   `session.ts:795` halts at `s.mode === "ict" ? 0.4 : DAILY_LOSS_PCT` — 40% of
   start in ICT mode — and the tape line at `:801` interpolates
   `DAILY_LOSS_PCT * 100`, so it always says **22%**. In ICT mode the user is
   told a 22% brake while a 40% brake is running, and `README.md` advertises
   "22% daily loss cap" as always on. Decide which is true, make the code and
   the copy agree, and add a test that asserts the printed percentage equals
   the enforced one in every mode. Hand the README half to CHECKER.

2. **`dayLoss` never resets.** It is set to `0` once at session creation
   (`:188`) and only ever incremented (`:340`, `:662`). There is no date
   rollover. So `DAILY_LOSS_PCT` is a **per-run** cap, not a daily one — which
   the halt line half-admits with "Reset to trade again", while the constant
   name, and the README, both say "daily". Either implement a real UTC-day
   rollover or rename the concept to `RUN_LOSS_PCT` and fix the copy. Do not
   leave it ambiguous; this is the brake users will ask about.

3. **The exposure cap and the sizing cap use different bases.** `canTrade`
   (`:229`) caps exposure at `s.startUsd * MAX_POS_PCT * MAX_OPEN` — pinned to
   the *starting* balance forever — while `positionSize` (`:239`) caps a single
   fill at `equityUsd * MAX_POS_PCT`, which grows with the book. After a good
   run, per-trade size scales up but total exposure does not, and the desk will
   silently stop taking the third position. Pick one base, state why in a
   comment, and test both a drawdown and a 10× book.

4. **`positionSize` has a `$1` floor that can outrank every cap.**
   `Math.max(1, Math.min(base, room*0.3, cash*0.2, equity*MAX_POS_PCT))` — when
   the caps compute below a dollar the floor wins and a fill opens anyway.
   `canTrade` currently keeps `room > 0`, so this is a latent bug rather than a
   live one. Make it explicit: either refuse the fill below a minimum ticket or
   document why $1 is always acceptable.

5. **`VIRTUAL_SOL_FALLBACK` is duplicated as a literal.** `session.ts:255` and
   `:289` pass `p.virtualSol ?? 30`; `execution.ts:11` exports
   `VIRTUAL_SOL_FALLBACK = 30`. Import the constant so the two cannot drift.

## Review checklist — the invariants that matter

Work these as assertions you can write tests for, not as a reading exercise.

**Conservation.** For any closed trade: `cash_after - cash_before` equals
`proceeds - gross - feeUsd_total - jitoUsd_total`, to the cent. Fees and tips
must land in `stats.feesUsd` / `stats.jitoUsd` exactly once each. Round-trip a
fill through `modelBuy` → `modelSell` at an unchanged mcap and confirm the user
ends **down** by exactly fees + two Jito tips + both slippage legs — never up.

**Both tips are charged.** `modelBuy.cashDebitUsd` includes one `jitoUsd`, and
`modelSell.proceedsUsd` deducts another. `revalue` then does
`proceeds - grossUsd - jitoUsd`. Verify that totals to exactly two tips per
round trip, not one and not three.

**Slippage always hurts.** `modelBuy` fills at `quoted * (1 + slip)`,
`modelSell` at `quoted * (1 - slip)`. Neither sign may ever flip, for any size,
including `sizeUsd = 0`, a negative input, and a size far above curve
liquidity. `MAX_SLIP = 0.45` caps it — confirm a 1000-SOL order into a 30-SOL
curve is capped and does not produce a negative fill price.

**No NaN reaches the user.** The engine leans on a `finite()` helper. Feed
`NaN`, `Infinity`, `0`, negative and `undefined` into `modelBuy`, `modelSell`,
`curveSlippage`, `scoreLive`, `revalue` and `positionSize` and assert every
returned field is finite. One `NaN` in `equityUsd` poisons the whole desk.

**Stops cannot be skipped.** `STOP_PCT = 0.5`. A mark at or through the stop
must close the position on that tick — with a gap far past the stop, the
realised loss should reflect the gap, not a clean −50%. Confirm a gap cannot
produce a *profit*.

**Brakes are unconditional.** `MAX_OPEN`, `MAX_DAILY_TRADES`, `DAILY_LOSS_PCT`
and the exposure cap must hold for `watch`, `live` and `ict`. `zostaff` is
exempt by design (`canTrade` returns `null` early at `:224`) because it replays
a published book — confirm that exemption cannot leak into another mode.

**Scoring gates are honest.** In `pipeline.ts`, `approved` must be exactly
`!skipReason && !vetoReason && score >= MIN_SCORE`. Check the `skipReason`
ladder order — `high_risk` is assigned *inside* the `if (!skipReason)` block
and overwrites nothing, but `risk > 7` is evaluated before `score < MIN_SCORE`,
so a high-risk token never reports `low_score`. Confirm that precedence is
intended, because it changes what the tape tells the user.

**Zostaff stays quarantined.** `origin: "published"` trades must never mix into
`live` statistics, and the three winners without published PnL must stay
labelled `implied`. Assert that no `live`-mode code path reads from
`zostaff.ts`.

**Determinism.** Same seed plus same snapshot must produce the same tape. If
`rng.ts` is seeded, prove replays are reproducible; if it uses `Math.random`
anywhere in a scoring path, that is a finding.

## Upgrade backlog — after the findings are closed

1. **Build the engine test suite.** This is the single highest-value change in
   the repo. Create `src/lib/engine/execution.test.ts` and
   `session.test.ts`, and add both to the `test` script in `package.json` —
   there is no glob for `src/`, so an unlisted file never runs. Start with
   conservation, the slippage sign, and the NaN sweep above. Ask RIGGER to gate
   CI on it once it is green.
2. **Make the cost model inspectable.** Every closed trade already carries
   `feeUsd`, `jitoUsd`, `slippagePct`, `quotedEntryUsd`, `quotedExitUsd`. Surface
   a per-trade cost breakdown so a user can see why a flat move lost money.
   Hand the rendering to FLOOR; you supply the numbers.
3. **Expectancy the honest way.** `SetupOdds` carries `winRate`, `avgR` and
   `expectancyR`. Show the sample size next to every rate and refuse to display
   a win rate under ~20 trades — a 3-trade 100% is a lie in a box.
4. **A real drawdown series.** Track peak equity and max drawdown alongside
   `EquityPoint`, so the tail-heavy Zostaff shape is visible as risk and not
   just as upside.

## Definition of done

- The gate block passes, and `npm test` has **more** passing tests than when
  you started — at least one new engine test per behaviour you changed.
- Every changed number has a test that fails on the old code.
- No risk brake loosened. If you tightened one, the PR body says why.
- Anything you found outside your files is written to `BOARD.md` under its
  owner, not silently left.
- Your PR body states, in the desk voice, what a user will now see differently.
