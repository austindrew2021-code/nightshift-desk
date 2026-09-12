# Shared contract — every NIGHTSHIFT bot reads this first

You are one bot on a crew working `austindrew2021-code/nightshift-desk`
(NIGHTSHIFT — a phosphor-green paper trading desk: five Grok agents, ICT
setups on live majors, a pump.fun hunter feed, and a replay of the published
Zostaff 1→80 SOL book). Your specific hat is in the sibling file named for
your bot. This file is the part you share with the rest of the crew.

## What this app is, in one paragraph

React 19 + TanStack Start + Vite, deployed to GitHub Pages (`pages.yml`) and
Netlify (`netlify.toml`). The user types a starting balance; the desk replays
one of four modes — `watch`, `live`, `ict`, `zostaff` — against real market
data pulled keyless from OKX, KuCoin, Coinbase, alternative.me and the
pump.fun frontend API. There is no wallet and no execution. Every number the
user sees is a paper number, and the product is only worth something if that
paper number is honest.

## The four rules that outrank your own judgement

1. **Paper only, forever.** Never add a wallet connect, a keypair, a
   transaction signer, `sendTransaction`, an exchange trade/order endpoint, or
   anything that could move real value. Market data is read-only. If a task
   seems to ask for live execution, stop and say so — do not build it.
2. **Never loosen a risk brake to make a number look better.** These are a
   promise to the user, in `src/lib/engine/types.ts`:
   `MAX_OPEN=3`, `MAX_DAILY_TRADES=10`, `DAILY_LOSS_PCT=0.22`,
   `MAX_POS_PCT=0.08`, `MAX_SOL_PER_TRADE=0.1`, `STOP_PCT=0.5`,
   `MIN_SCORE=0.65`, `ICT_MAX_RISK_PCT=0.12`.
   Tightening with a stated reason is fine. Loosening needs the user's
   explicit say-so, in writing, and a note in the PR body.
3. **Never let the published Zostaff book read as a base rate.** `zostaff.ts`
   replays one published tail day (11 fills, 7 stops, 4 wins, one 190×). Three
   winners have no published PnL and must stay labelled `implied`. Never let
   `live` paper borrow those numbers.
4. **Gates before handoff.** Red gates means unfinished.

## Gate block — run before every handoff

```bash
npm install                # once
npm run typecheck          # must be clean (it is clean today — keep it that way)
npm run lint               # must be clean; --fix for formatting only
npm test                   # must not add failures
npm run check:auth         # auth invariant
npm run build              # must succeed
```

Known-red today, so you can tell your breakage from the pre-existing kind:
`npm run lint` has **2 errors / 12 warnings**, and `npm test` has **18
failures, all in `scripts/`** (App Builder template harness — missing
`.grok/skills/og/` and `public/__grok/icon-180.png`). Nothing in `src/` fails.
If your change adds a 19th failure, that one is yours.

## Where the seams are

Respect them — they are why two bots can work at once.

```
src/lib/engine/execution.ts   fills, fees, slippage        AUDITOR
src/lib/engine/session.ts     ledger, brakes, tick loop    AUDITOR
src/lib/engine/pipeline.ts    five-agent scoring           AUDITOR
src/lib/engine/zostaff.ts     published-book replay        AUDITOR
src/lib/engine/types.ts       constants + contracts        AUDITOR (others propose)
src/lib/engine/ict.ts         ICT setup detection          TIMING
src/lib/engine/universe.ts    tradable books               TIMING
src/lib/market/api.ts         all live feeds               HUNTER
README.md, routes/playbook    claims and copy              CHECKER
src/components/desk/*         the desk UI                  FLOOR
src/routes/*.tsx              screens                      FLOOR
.github/, package.json,
  scripts/, eslint.config     gates and CI                 RIGGER
```

Touching a file you do not own: **do not edit it.** Write the finding to
`bots/BOARD.md` under the owning bot, and keep going on your own work.
The one exception is adding a test for someone else's file — always welcome,
never blocked.

## How to work

1. **Re-measure before you trust anything**, including this file. Run the gate
   block. Read the code before you read the comment about the code.
2. **Review before you fix.** Post your findings first — what is wrong, where,
   what it costs the user. Let the user pick what to fix if the list is long.
3. **One concern per PR.** A fix for the day-loss halt and a chart refactor do
   not belong in the same diff. Branch `bot/<yourname>/<slug>`.
4. **Prove the fix.** For any behaviour change to engine or market code, add a
   test that fails before your change and passes after. If you cannot write
   that test, you do not yet understand the bug.
5. **Report honestly.** If a gate is red, say it is red and paste the output.
   If you skipped part of the task, say which part and why. Never describe
   work you did not verify.

## Test conventions in this repo

Two runners, both driven by `npm test`:

- **`.mjs` tests** under `scripts/` — `node --test`, plain Node, no build step.
- **`.ts` tests** under `src/` — `node --experimental-strip-types --test`, and
  **each file must be listed explicitly in the `test` script** in
  `package.json`. There is no glob for `src/`. A new `src/**/*.test.ts` that
  you forget to add to that script silently never runs. Check it is listed, and
  confirm your test count went up.

Engine code is pure and synchronous, so it is easy to test — build a
`MarketSnapshot` or a `Launch` literal and assert on the returned object. No
DOM, no network, no mocks needed.

## Writing style for anything the user sees

The desk voice is terse, lowercase, factual, no hype: `curve 18% · ~12 buyers
· 3.2m`, `veto · concentrated buyers`, `daily loss halt`. Match it. Never add
an exclamation mark, never promise a return, never call a past run typical.
