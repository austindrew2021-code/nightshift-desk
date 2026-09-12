# BOARD — the work queue

Findings verified on commit `08993dd`, 2026-09-11, after `npm install`, by
reading the code and running every gate the repo defines. Each bot works its own
rows. **Re-confirm a row before you fix it** — the board can go stale.

Add new findings under the owning bot. Never delete a row; strike it and note the
commit that closed it, so the next bot knows it was considered.

## Priority queue

| # | Sev | Owner | Finding | Where |
| --- | --- | --- | --- | --- |
| 1 | ~~critical~~ | ~~TIMING~~ | ~~NY offset hardcoded to EDT~~ — fixed via `Intl.DateTimeFormat`, tested both offsets | closed |
| 2 | **critical** | RIGGER | CI runs no gate; nothing can stop a regression | `pages.yml` |
| 3 | high | all | Engine tests started (8 in `ict.test.ts`); `session.ts` and `execution.ts` still bare | `src/lib/engine/` |
| 4 | high | AUDITOR | Day-loss halt enforces 40% in ICT, prints 22% | `session.ts:795,801` |
| 5 | high | AUDITOR | `dayLoss` never resets — a per-run cap called "daily" | `session.ts:188,340,662` |
| 6 | high | CHECKER | README says 20 fills/day; code enforces 10 | `README.md:32` |
| 7 | high | HUNTER | Pages deploy is static, but all data goes through server fns | `api.ts:308+` |
| 8 | high | FLOOR | Zero ARIA in all 7 desk components | `components/desk/*` |
| 9 | med | RIGGER | 18 failing tests, all template harness in `scripts/` | `npm test` |
| 10 | med | RIGGER | New `src/**/*.test.ts` silently never runs unless hand-listed | `package.json` |
| 11 | med | AUDITOR | Exposure cap uses `startUsd`; sizing uses `equityUsd` | `session.ts:229,239` |
| 12 | med | HUNTER | `Promise.all` ×5 — one dead endpoint kills a whole batch | `api.ts:101,124,339,350,369` |
| 13 | med | HUNTER | No cache, throttle or backoff; ~48 requests per refresh | `api.ts:12` |
| 14 | low | RIGGER | 2 lint errors | `ict.ts:1166`, `client.server.ts:281` |
| 15 | low | RIGGER | 9 dependencies declared, imported nowhere | `package.json` |
| 16 | low | AUDITOR | `positionSize` `$1` floor can outrank every cap | `session.ts:239` |
| 17 | low | AUDITOR | `?? 30` duplicates `VIRTUAL_SOL_FALLBACK` | `session.ts:255,289` |
| 18 | low | TIMING | `equalPool` / `impulseRange` written but never wired | `ict.ts:694,715` |
| 19 | low | CHECKER | `high_risk` / `low_score` leak snake_case into the tape | `pipeline.ts:70` |
| 20 | **critical** | TIMING | 71% of signals need future bars to be detected — lookahead | `ict.ts` `scanIct` |
| 21 | ~~critical~~ | ~~AUDITOR~~ | ~~`simulateIct` applies zero costs~~ — `IctCosts` added, on by default | closed |
| 22 | ~~high~~ | ~~AUDITOR~~ | ~~Exits fill at exact stop price~~ — stops now fill at the bar open on a gap | closed |
| 23 | high | AUDITOR | 12% risk/trade is what produces the 13x, not edge | `types.ts:254` |
| 24 | ~~high~~ | ~~AUDITOR~~ | ~~`div` auto-fills at signal price~~ — market entries fill at the next open | closed |
| 25 | ~~med~~ | ~~FLOOR~~ | ~~PWA not installable: manifest named "Grok App", icon 404s~~ | closed `b7499b2`+ |
| 26 | ~~low~~ | ~~RIGGER~~ | ~~eslint had no `.netlify/**` ignore; a local build broke lint~~ | closed |

Recommended first three: **20** (lookahead), **21** (costs), **2** (gates). Rows 20
and 21 outrank everything else on this board: until they are fixed, no number the
desk reports about profitability means anything, so no strategy work is worth
doing. Then **1** (the clock) and **4** (the brake that lies). After those, everything else stays fixed once fixed.

---

## Detail

### 1 · NY offset hardcoded to EDT — critical — TIMING

`const NY_OFFSET_MS = 4 * 3600_000; // EDT in September`

`nyParts` subtracts a flat 4 hours. Correct today; wrong from **Sunday 1
November 2026**, when New York returns to EST (UTC−5) until mid-March. Every
window built on `nyHour` then sits an hour late: Silver Bullet fires 09:00–10:00
NY instead of 10:00–11:00, London/NY AM/Judas/NY PM all shift, and `buildAsia`
mis-buckets days. The engine keeps producing a confident tape the whole time,
which is what makes it dangerous. Fix with `Intl.DateTimeFormat` on
`America/New_York`. Full brief in `TIMING.md`.

### 2 · CI enforces nothing — critical — RIGGER

`pages.yml` runs `npm ci` → `npm run build:pages` → deploy. No typecheck, lint,
test or `check:auth`, and it only triggers on push to `main` plus manual
dispatch, so PRs get no signal. Land a `verify` job that `deploy` needs, add
`on: pull_request`, and land it together with row 9 so `main` does not simply
turn red.

### 3 · The engine has no tests — critical — all

`ict.ts` 1322, `session.ts` 1163, `zostaff.ts` 323, `types.ts` 258,
`pipeline.ts` 116, `execution.ts` 110, plus `market/api.ts` 469. No test file
imports any of it. For an app whose only product is an honest paper ledger this
is the largest structural risk in the repo. The code is pure and synchronous, so
it is cheap to test — build a `Launch` or `MarketSnapshot` literal and assert on
the result. Each bot owns tests for its own files; see row 10 first, or the tests
will not run.

### 4 · The day-loss halt prints a number it does not enforce — high — AUDITOR

```ts
if (finite(s.dayLoss) >= s.startUsd * (s.mode === "ict" ? 0.4 : DAILY_LOSS_PCT)) {   // :795
  text: `daily loss halt · $${...} / ${(DAILY_LOSS_PCT * 100).toFixed(0)}% · ...`     // :801
```

In ICT mode the brake is 40% of start; the message always says 22%. `README.md`
advertises 22% as always on. Make code and copy agree, and test that the printed
percentage equals the enforced one in every mode. README half → CHECKER.

### 5 · `dayLoss` never resets — high — AUDITOR

Set to `0` once at creation (`:188`), only ever incremented (`:340`, `:662`). No
date rollover, so `DAILY_LOSS_PCT` is a per-**run** cap. The halt line's "Reset
to trade again" is honest; the constant name and the README are not. Implement a
real UTC-day rollover, or rename to `RUN_LOSS_PCT` and fix the copy.

### 6 · README overstates the fill cap 2× — high — CHECKER

`README.md:32` "20 fills/day" vs `MAX_DAILY_TRADES = 10` (`types.ts:240`),
enforced at `session.ts:225`. One-line fix, but it is exactly the class of drift
row 19's claims test would prevent forever.

### 7 · The public deploy may not be the live desk — high — HUNTER

`emit-gh-pages.mjs` flattens `dist/client` into a static SPA. All market data
flows through `createServerFn` (`api.ts:308,333,362,385,401`), and `consultGrok`
needs `process.env.XAI_API_KEY`. A static host has no server for any of it, so
either the calls 404 into `fallback-klines.json` while the UI still looks live,
or they inline into the browser where CORS blocks `frontend-api-v3.pump.fun`.
**Measure it before proposing a fix** (`npm run build:pages`, serve `dist/pages`,
watch the network panel and `source`). Then it is a product decision with the
user: label Pages a frozen demo, move to Netlify's server, or add a proxy.

### 8 · No ARIA anywhere on the desk — high — FLOOR

All seven `components/desk/*` files contain zero `aria-` attributes and zero
`role=`. A streaming tape, a live equity figure and a halt notice are all
unannounced, and the canvas chart is entirely invisible to a screen reader.
Minimum: `role="log"` + `aria-live="polite"` on the tape, `aria-live` on equity,
`assertive` on the halt, labels on icon-only controls, `role="img"` + summary
label on the chart. `prefers-reduced-motion` is already handled
(`styles.css:65`) — keep it and extend it to the canvas redraw.

### 9 · 18 failing tests, all template harness — med — RIGGER

All in `scripts/`: `og` skill, `grok-pwa-plugin`, `with-app-env`, nitro wiring,
`brand-check`. They assert on App Builder scaffolding this repo no longer
carries — missing `.grok/skills/og/SKILL.md`, `.grok/skills/og/references/`,
`public/__grok/icon-180.png`. Nothing under `src/` fails.

**Root cause, confirmed:** `.gitignore` ignores `.grok/` (line 6) and
`public/__grok/` (line 15). Those assets exist in the App Builder sandbox but
were never committed, so they cannot exist in CI or in any fresh clone. These
tests therefore cannot pass in this repo as configured — which is also why this
bot crew lives in `bots/` at the root rather than under `.grok/`. Restoring the
assets means un-ignoring them deliberately; scoping the tests out means
admitting they test the template, not the app. Either split
`test:app` / `test:template` and gate only the former, or restore the assets if
the PWA install flow is genuinely live. **Do not delete or skip the tests.**

### 10 · `src/` tests must be hand-listed — med — RIGGER

The `test` script names four `src/**` test files explicitly; there is no glob.
Four bots are about to add engine and market tests, and any file they forget to
register silently never runs — the suite goes green while testing nothing. Add a
check that fails when a `src/**/*.test.ts` exists but is absent from the script.

### 11 · Two bases for one cap — med — AUDITOR

`canTrade` caps exposure at `startUsd * MAX_POS_PCT * MAX_OPEN` (`:229`), pinned
to the starting balance forever, while `positionSize` caps a fill at
`equityUsd * MAX_POS_PCT` (`:239`), which grows with the book. After a good run
per-trade size scales up but total exposure does not, so the desk quietly stops
taking a third position. README says "8% of book", which implies equity. Pick
one, comment why, test a drawdown and a 10× book.

### 12 · `Promise.all` loses good data — med — HUNTER

Five `Promise.all` vs two `allSettled`. In the per-book paths (`:339`, `:350`)
one delisted or rate-limited symbol rejects the whole pack and the user loses all
twelve ICT books. Convert batch fetches to `allSettled`, keep what arrived, mark
the rest missing.

### 13 · No rate limiting — med — HUNTER

`getJson` has a 2800ms timeout, no retry, no cache, no throttle. Twelve ICT
assets × (stats + 3 timeframes) ≈ 48 requests per refresh on top of the
snapshot's dozen, against public OKX/KuCoin endpoints. 429s are a matter of tab
count, and today they trigger row 12's collapse. Add a TTL cache, a concurrency
limit, and `Retry-After`-aware backoff.

### 14 · Two lint errors — low — RIGGER

`ict.ts:1166` `prefer-const` on `curTgt` (TIMING's file — coordinate);
`client.server.ts:281` `no-empty`, likely a swallowed error — look at what it
discards rather than silencing it. The 12 warnings are unused vars belonging to
TIMING and AUDITOR; they should wire or delete, not underscore-rename.

### 15 · Nine unused dependencies — low — RIGGER

Zero imports under `src/` or `server/`: `recharts`, `react-day-picker`, `cmdk`,
`react-resizable-panels`, `@tanstack/react-table`, `react-hook-form`,
`@hookform/resolvers`, `sonner`, `date-fns`. Most `@radix-ui/*` are unused too —
`src/components/ui/` holds only `button.tsx`. Template residue: install time,
lockfile size, supply-chain surface. Confirm with FLOOR, remove in one PR.

### 16 · `positionSize` floor outranks the caps — low (latent) — AUDITOR

`Math.max(1, Math.min(base, room*0.3, cash*0.2, equity*MAX_POS_PCT))` — when the
caps compute under a dollar the `$1` floor wins and a fill opens anyway.
`canTrade` currently keeps `room > 0`, so it is latent. Make it explicit: refuse
below a minimum ticket, or document why `$1` is always fine.

### 17 · Duplicated fallback constant — low — AUDITOR

`session.ts:255` and `:289` pass `p.virtualSol ?? 30`; `execution.ts:11` exports
`VIRTUAL_SOL_FALLBACK = 30`. Import it so they cannot drift.

### 18 · Dead ICT features — low — TIMING

`equalPool` (`:694`) and `impulseRange` (`:715`) are written, lint-flagged, and
never called. Equal highs/lows are a real draw on liquidity, so their absence is
a genuine gap in the method — wire them into `scanIct` or delete them. Not an
underscore rename.

### 19 · Developer spelling in the tape — low — CHECKER

`skipReason` values `high_risk` and `low_score` (`pipeline.ts:70-71`) reach the
UI in snake_case while every sibling reason is prose (`too late on curve`,
`empty curve`). Also note the precedence: `risk > 7` is tested before
`score < MIN_SCORE`, so a token that is both never reports `low_score` — confirm
that is intended, because the tape is telling the user *why* it passed.

### Build the claims test — CHECKER

Not a defect; the fix that retires a whole class of them. A test that reads
`README.md` and asserts every risk number matches its exported constant makes
rows 4, 5, 6 and 11 permanently self-policing.


---

### 20 · 71% of ICT signals require future bars — critical — TIMING

Measured 2026-09-12 against live OKX 15m candles, 11 books, 300 bars each. For
each signal emitted at bar `i`, the series was truncated to `0..i` and `scanIct`
re-run. **36 of 51 signals vanished** — they cannot be detected at the bar they
claim to fire on:

```
div       20 / 24   83%
ob         8 /  8  100%
breaker    3 /  3  100%
ifvg       2 /  2  100%
swing      3 /  8   38%
```

`simulateIct` then begins looking for the fill at `s.i + 1` (`ict.ts:1168`), so
entries are placed on information that did not exist yet. Some of this may be
legitimate detection *lag* rather than true lookahead — a fractal needs bars to
its right before it is known — but the effect on the backtest is identical: the
trade is entered before the signal was knowable. Either way it must be fixed at
the same place, by giving every signal an "earliest knowable bar" and refusing
to fill before it.

`div` is the sharpest case: 83% lookahead-dependent, 24 of 49 signals, and the
highest win rate in the book. It is carrying the results.

Reproduce: the probe in `scripts/ict-probe.ts` plus the truncation loop described
above. Turn it into a permanent test — `ict.test.ts` should assert that every
signal survives truncation at its own bar.

### 21 · `simulateIct` models no trading costs at all — critical — AUDITOR

```ts
const r = ((exit - s.entry) * dir) / Math.abs(s.entry - s.stop);
const pnlUsd = r * riskUsd;                    // ict.ts:1223-1227
```

That is the whole PnL calculation. No exchange fee, no spread, no slippage, no
funding — on a position `ictRiskUsd` sizes up to **12× book notional**
(`ICT_MARGIN_PCT 0.8 × ICT_LEVERAGE 15`). Meanwhile `execution.ts` carefully
models 1% pump fee, Jito tip and curve slippage for the meme path, so the ICT
path is the one place costs were skipped.

Scale of the omission: at the measured **median stop distance of 0.41% of
price**, round-trip taker fees at 0.05% a side cost `0.001 / 0.0041 ≈ 0.24R`
per trade — before funding. A quarter of an R off every trade, on a strategy
whose honest edge is unknown.

Fix: charge fee, spread and funding inside `simulateIct` (or return a cost
breakdown the caller applies), then re-measure every `SetupOdds` number.

### 22 · Exits fill at exact stop/target prices — high — AUDITOR

`exit = curTgt` and `exit = curStop` (`ict.ts:1190-1216`) fill at the precise
level whenever the bar's range touches it. Real fills gap through stops and slip
on targets. The tell is in the output: across 38 trades `avgR` came out at
**exactly +1.000**, and every per-setup average landed on an exact integer
(−1.00, +1.00, +2.00). Price action does not do that; quantised fills do.

This biases in one direction — losses are capped at exactly −1R when a real gap
would take more, and wins are booked at exactly the target when a real fill
would be worse. Add gap handling: if a bar opens beyond the stop, fill at the
open, not the stop.

### 23 · The 13x is position size, not edge — high — AUDITOR

`ICT_MAX_RISK_PCT = 0.12` (`types.ts:254`) risks **12% of book per trade**, about
six times the conventional 2%. `ictRiskUsd` is called with a flat 1% stop
assumption (`session.ts:793`, `ictRiskUsd(s, 0.01)`), which lands notional on the
`book × 0.8 × 15` cap, so risk resolves to 12% of book on essentially every
trade.

Compounding is the whole story: roughly twelve net 2R wins at 12% risk is
`1.24^12 ≈ 12.8×`. A $100 start reaching ~$1,300 needs no edge beyond a coin
flip biased slightly right — which is exactly what rows 20-22 manufacture. On the
same trade list, 2% risk with costs applied returns about 1.6×, not 17×.

`maybeBank` (50% of every $100 into a vault) is a genuinely good brake and does
dampen this. It does not change the conclusion.

Do not treat this as "reduce the number". Treat it as: the number is currently
doing the work that edge is supposed to do, and that will not be visible until
rows 20-22 are closed.

### 24 · `div` setups fill for free — high — AUDITOR

```ts
let filled = s.setup === "div";                // ict.ts:1156
```

Every other setup must wait for price to trade through the entry
(`c.l <= s.entry && c.h >= s.entry`). `div` is marked filled at the signal price
immediately, whether or not price was ever there. `div` was 24 of 49 signals and
the highest-winning setup. Combined with row 20 (83% of `div` signals need future
bars) this is the single largest source of fake PnL in the engine.

### 25 · PWA install — CLOSED

The manifest was the template's `/__grok/manifest.webmanifest`, synthesised
per-request from the hostname: off a `*.grok.me` host `appNameFromHost` falls
back to `DEFAULT_APP_NAME = "Grok App"`, and the only icon it declares
(`/__grok/icon-180.png`) is not in the repo because `.gitignore:15` ignores
`public/__grok/`. Verified against a real Netlify-preset build: manifest 200 but
named "Grok App", icon **404** — and an icon that does not load costs Android
installability outright.

Now ships its own `public/manifest.webmanifest` (name NIGHTSHIFT, standalone,
phosphor `#070b09`, 192/512/maskable icons generated from `favicon.svg`) with
relative URLs so it resolves under both `/` and `/nightshift-desk/`. The template
`__grok` middleware is untouched. Verified 200 on every asset.

### 26 · eslint linted build output — CLOSED

`eslint.config.mjs` ignored `dist`, `.output`, `.vercel` and `.nitro` but not
`.netlify` — yet `vite.config.ts:177` selects the **netlify** preset whenever
`NETLIFY` is set, which `netlify.toml` does. So anyone running a production build
locally then linting got hundreds of errors from vendored third-party bundles.
Added `.netlify/**` and `.tanstack/**`.


---

### 27 · Off-hours ICT signals are the biggest single loss — NEW, actioned

Backtested 2026-09-12 on **414 trades over 41 days**, 44,000 bars of 15m across
the 11 OKX books, with `DEFAULT_ICT_COSTS` applied (0.05% fee/side, 0.02%
slip/side, 0.01% funding/8h) and a 60/40 train/test split.

Out of sample, gating signals to London / NY AM / Silver Bullet / NY PM:

```
all hours      n=185  win 55%  avgR -0.073  t-ish -0.3   2% risk -> $192  maxDD 20%
killZoneOnly   n=171  win 57%  avgR +0.227  t-ish  2.0   2% risk -> $213  maxDD 19%
```

The 14 off-hours trades averaged roughly **-3.7R each** — thin-hour bars gap
straight through stops, which only became visible once row 22 made gap fills
honest. This is the published method rather than a tuned filter, and it is
confirmed out of sample, so `scanIct` gained `killZoneOnly` and `session.ts`
passes it for both the 15m and 5m passes.

### 28 · `amd` (Power of 3) is broken, not just unprofitable — OPEN, TIMING

Same backtest, per setup, train vs test average R:

```
div       train n=147 +0.13R   test n=115 +0.42R   holds up
swing     train n=  2 -1.52R   test n= 19 -0.14R   negative
breaker   train n= 16 -0.00R   test n= 16 -0.12R   negative
silver    train n= 28 -0.65R   test n= 13 -0.13R   negative
amd       train n=  8 -0.77R   test n=  8 -6.70R   negative
ob        train n= 17 +0.00R   test n=  6 -0.43R   negative
judas     train n=  6 -0.89R   test n=  6 -0.26R   negative
ifvg      train n=  5 -1.29R   test n=  2 +1.26R   thin
```

**-6.70R average** on 8 trades is not a bad edge, it is a bug — a correct 2R
setup cannot lose almost seven times its risk unless the stop is wrong, inverted,
or effectively absent. Prime suspect is `stopPad` at the 9am bar
(`(nine.h - nine.l) * 0.08 || entry * 0.002`): on a doji that pad collapses, the
stop distance goes near zero, and `notional = risk / stopPct` explodes. Find it,
fix it, add a test asserting no setup can lose more than ~2R after slippage.

`silver` at -0.65R train / -0.13R test also deserves a look — the Silver Bullet
is the headline setup in the README and it currently loses money.

Do **not** respond to this table by deleting the negative setups. Selecting
setups on the test set is fitting the test set; the table says which
implementations to go and read.

### 29 · `npm test` never ran the app's own tests — CLOSED

The `test` script was `node --test 'scripts/**/*.test.mjs' && node
--experimental-strip-types --test src/...`. The template suite fails (row 9), so
`&&` short-circuited and **the entire `src/` suite never ran** — 63 tests,
including the auth and app-data ones that predate this work, all invisible. They
were green the whole time; nobody could see it.

Split into `test:app` (src, the gate) and `test:template` (scripts, known-red
template harness), with `npm test` pointing at `test:app`. `npm test` is now
**63 passing, 0 failing** and means something. Row 9's decision is therefore
taken: the template suite is scoped out of the gate, not deleted — run it with
`npm run test:template`.

This also supersedes the narrower row 10: registration was never the only
problem.


---

### 28 · `amd` at -6.70R was one broken stop — CLOSED

Not a weak edge. Measured stop distance per setup across 41 days showed one
`amd` signal on BTC with a stop **0.0032% of price** — roughly $3 on a $95k
chart. R is normalised by stop distance, so an ordinary adverse bar on that
trade reported **-46.4R**, and that single trade was essentially the whole of
`amd`'s -6.70R out-of-sample average.

Cause: `amd` builds `entry` from the FVG midpoint but `stop` from the swept Asia
extreme plus a pad of only 6% of the Asia range (`ict.ts`, the AMD block). When
those two references nearly coincide the stop collapses toward zero. `pack()`
already rejected stops that were too **wide** (3% of price) and had no floor at
all on the other side.

Fixed with a volatility floor in `add()`, so it covers every setup including
`scanSwing`'s: a signal whose stop is closer than `MIN_STOP_ATR` (0.25) times ATR
at the signal bar is dropped. A stop inside the noise band is not risk. It is a
sanity floor, deliberately not tuned for return.

Effect — worst single trade per setup, before → after:

```
amd     -46.4R -> -1.6R     (n 16 -> 15: it removed exactly one trade)
silver   -3.2R -> -2.2R
ob       -3.7R -> -2.9R
worst overall -46.4R -> -3.9R
```

And on the full out-of-sample run, TRAIN average went from **-0.090R to
-0.006R** — the outlier was most of the training-set loss. TEST improved from
+0.227R to +0.241R, t-ish 2.0 to 2.2.

### 30 · Strategy variant sweep — "exit on reversal" wins, two variants are untested

`scripts/ict-variants.ts` (`npm run variants:ict`) scores variants on TRAIN and
TEST. 15m, 11 books, killZoneOnly, costs on, $100 at 6% risk:

```
variant                TRAIN avgR   TEST avgR   TEST $   t    maxDD
baseline (shipped)         +0.008      +0.221     $297   2.0    55%
exit on reversal           +0.015      +0.229     $313   2.1    51%
target 3R                  +0.048      +0.229     $235   1.7    69%
target 1.5R                -0.065      +0.031     $118   0.4    61%
breakeven at 1R            -0.525      -0.398       $4  -5.0    98%
trail every setup          -0.526      -0.420       $0  -5.3   100%
```

**Adopted: exit on reversal.** Closes at the bar close when the same engine that
found the entry finds an opposing signal. Marginally better expectancy than
baseline and, more usefully, the lowest drawdown of any profitable variant. Now
on in `session.ts` for the 15m pass.

**`breakeven at 1R` and `trail every setup` are NOT disproven — the test is
unsound.** Win rate collapsing to ~20% is not what a breakeven stop does; it is
what an intra-bar ordering bug does. Both rules check max-favourable-excursion
against the *same* bar that is then tested for the stop, so a bar that touches
both +1R and the entry is scored as moving the stop up and then being stopped at
it, when the real intra-bar path may have reached the target first. Resolving
this needs 5m or 1m bars to sequence events inside each 15m bar. Until then
neither variant has been evaluated.

That bias also applies to the **pre-existing** `trail` path, which is on for
`silver`, `judas`, `asia` and `scalp` — and those are among the negative setups
(`silver` -0.30R, `judas` -0.26R out of sample). Worth checking whether the trail
logic, not the setups, is what is losing. TIMING owns this.

### What the numbers imply for the $100 target

TEST window is 16.4 days. At 6% risk per trade, exit-on-reversal turned $100 into
$313 — 3.13x, or about **1.63x per week**. Compounding at that rate:

```
$100 -> $1000   ~4.7 weeks (33 days)   maxDD 51%
```

One week would require **39% per day compounded**. At the measured +0.229R edge
that needs risk near 100% of book per trade, where a single stop is ruin. The
honest ceiling on this data is weeks, not a week — and TRAIN at +0.015R means
even 1.63x/week is plausible-but-unproven, not established. t-ish 2.1 is right at
the edge of meaning anything.


---

### 31 · Intra-bar order now resolved from 5m sub-bars — CLOSED

Row 30 reported `breakeven at 1R` and `trail every setup` as untested rather
than disproven, because both checked favourable excursion against the same
coarse bar they then tested for the stop. `simulateIct` now takes
`opts.subBars` and, when given finer bars, walks them in order inside each
coarse bar — so fill, trail update, stop and target are sequenced by what
actually happened rather than by assumption. Verified on 130,900 5m bars against
the same 41-day 15m window.

The bias was real and large, and it cut both ways:

```
                         TEST avgR   before -> after
breakeven at 1R            -0.398 -> -0.175      (win 19% -> 30%)
trail every setup          -0.420 -> -0.220      (win 20% -> 30%)
baseline                   +0.221 -> +0.210      (t 2.0 -> 1.9)
exit on reversal           +0.229 -> +0.215      (t 2.1 -> 1.9)
```

So the trailing rules were being scored about twice as badly as they deserved —
**and they are still clearly negative once corrected**. That is now a real
result: a breakeven stop in this system cuts winners, dropping the win rate from
55% to 30%. Meanwhile the two profitable variants were being scored slightly
*optimistically*, because some trades credited with reaching target actually hit
the stop first.

### 32 · `trailNone` tested — hypothesis was wrong, shipped trail stays

Row 30 suggested the shipped trail (on for `asia`, `scalp`, `silver`, `judas`)
might be what makes those setups negative. Tested directly with `trailNone`:

```
baseline (trail on those 4)   TEST +0.210R  $308  t 1.9
NO trail anywhere             TEST +0.192R  $279  t 1.7
no trail + exit reversal       TEST +0.197R  $289  t 1.8
```

Disabling it is **worse**, not better. The trail is mildly helpful and stays on.
Recorded so nobody re-runs this. Those setups are negative for some other
reason.

### 33 · No variant clears statistical significance — the sample is the problem

Thirteen variants, 41 days, ~390 trades, costs on, intra-bar order resolved. Best
is exit-on-reversal at TEST **+0.215R, t 1.9**. Every single variant is **below
t = 2.0**, and TRAIN sits at −0.018R.

TRAIN ≈ 0 and TEST ≈ +0.21 with t < 2 has one most-likely reading: the strategy
is somewhere around breakeven, and the positive test figure is period-specific
rather than a durable edge. It is not established either way — that is the point.

The productive response is **not another variant**. Thirteen variants on 390
trades will eventually produce something that looks good by chance; that is how
backtests lie. The response is more data, so the t-statistic can settle. See
row 34.


---

### 34 · Six months, 1,655 trades: there is no measurable edge — DECISIVE

Row 33 said the answer was more data, not more variants. Ran it: **181 days,
182,062 bars, 11 books, 1,655 trades**, killZoneOnly, costs on, same 60/40 split.

```
ALL     n=1655  win 50%  avgR -0.018  avgWin +1.31  avgLoss -1.32  t-ish -0.5
TRAIN   n= 978  win 48%  avgR -0.045                                t-ish -1.0
TEST    n= 677  win 51%  avgR +0.021  avgWin +1.31  avgLoss -1.34  t-ish  0.4

TEST at 2% risk  -> $146   (maxDD 78%)
TEST at 6% risk  -> ruin
TEST at 12% risk -> ruin
```

**Out-of-sample expectancy is +0.021R with t = 0.4.** That is indistinguishable
from zero. `avgWin +1.31` against `avgLoss -1.34` at a 50% win rate is a coin
flip that pays slightly less than it costs — which is exactly what a strategy
with no edge looks like once fees, spread, funding and honest gap fills are
charged.

The 41-day figure that looked promising (+0.215R, t 1.9) was **a favourable
41-day window**, nothing more. Four times the sample erased it. This is the
single most useful number produced in this whole effort, and it is the reason
not to size up.

Two caveats, both in the same direction:

- **This is still optimistic.** Board row 20 is open: 71% of signals need future
  bars to be detected, and `simulateIct` fills from the bar after the signal. The
  true figure is likely below +0.021R, not above.
- The "ruin" rows overstate the ending slightly. `positionSize`'s `$1` minimum
  (row 16) means that once the book decays under ~$50 the floor risks more than
  the intended percentage and finishes it. Without that floor the curve decays
  asymptotically instead of touching zero. The direction is real; the exact zero
  is partly that artifact.

**What this means for the $100 → $1000 goal: it is not reachable with this
strategy.** Not at 2%, not at 6%, not at 12%. With expectancy at zero, raising
risk raises variance only — the higher-risk rows do not reach the target faster,
they reach ruin faster. No stop/target/trail variant changed this; thirteen were
tried.

**Do not respond to this by hunting a fourteenth variant on this sample.** With
1,655 trades and a true edge of zero, enough variants will eventually produce one
that looks significant by chance. That is the mechanism by which backtests lie,
and it is now the main risk to this project.

The honest next steps, in order:

1. **Close row 20 (lookahead).** Until signals are only emitted when they are
   knowable, every number here is unreliable in the optimistic direction. This is
   the only work that can change the verdict rather than decorate it.
2. Then re-run this exact six-month test. If expectancy is still ~0, the ICT
   implementation as written has no edge and the app's value is as an honest
   simulator and teaching tool — which is a real thing to be, and it is what the
   README already claims.
3. Only if expectancy survives step 2 is position sizing worth discussing.


---

### 35 · Strategy search across every named family — nothing reaches the goal

Implemented the families that were missing and tested all of them with a
**three-way split** (train 50% develop / validation 25% select / holdout 25%
scored once). The split matters: comparing 16 candidates against one test set
means the winner is chosen *by* that set, so its score is selection material, not
an estimate of the future.

`src/lib/engine/strategies.ts` adds, all strictly causal (bar `i` sees only
0..i, unlike `scanIct` — board row 20):

- **volume profile / POC** — nothing previously used the `v` field at all.
  `profile()` bins trailing volume, finds the POC and the 70% value area.
  Setups: reversion from outside the value area, rejection off the POC, value-area
  breakout.
- **NY open** — real 09:30 cash open, 30-minute opening range, broken or faded in
  the 10:00-11:30 window. `isNyAm` (07:00-10:00) never isolated this.
- **NY close** — the 15:00-16:00 hour: day-extreme sweep reversal, and late-day
  continuation.
- **divergence, split** — `ict.ts` folds regular and hidden div into one `div`
  setup, so which half carries the result was unmeasurable. Now separable.
  (Hidden div was already implemented, `ict.ts:683` — it was never missing.)

182 days, 11 books, costs on. Validation expectancy:

```
ICT all (shipped)      n=  379  +0.066R   t   0.9
ICT all hours          n=  430  +0.009R   t   0.1
POC breakout           n= 1748  -0.171R   t  -6.0
NY open ORB            n=  517  -0.278R   t  -4.7
div regular only       n= 2136  -0.365R   t -12.6
NY open fade           n=  655  -0.374R   t  -6.8
div hidden only        n= 2597  -0.425R   t -15.3
POC reversion          n= 4142  -0.420R   t -17.0
NY close reversal      n=   48  -0.502R   t  -2.6
POC rejection          n= 6015  -0.649R   t -34.3
NY close drift         n=  786  -0.854R   t -21.7
everything combined    n=14290  -0.490R   t -40.1
```

**Every new family is decisively negative** — t from −5 to −40 on thousands of
trades. That is not noise; these are reliable losers after costs.

Selected (rule fixed in advance: highest validation t among candidates with ≥60
validation trades and positive validation expectancy): **ICT all, as shipped.**

```
HOLDOUT (46 days, scored once)   n=435  win 52%  avgR +0.071R  t 1.0

  risk  2% -> $189  maxDD 55%  1.10x/week
  risk  6% -> $273  maxDD 88%  1.17x/week
  risk 12% -> $550  maxDD 94%  1.30x/week
  risk 25% -> $687  maxDD 92%  1.34x/week
```

At 25% risk a month returns about **$350**, with a 92% drawdown along the way —
$100 down to $8 at the worst point, which is ruin in practice whatever the final
figure says. And t = 1.0 means +0.071R is not distinguishable from zero, so those
dollars are one lucky path, not an expectation.

**Two honest caveats, both important:**

1. **The new families over-trade.** Unfiltered `scanDiv` fires 9,545 times in 90
   days across 11 books — roughly ten signals a day per book. At ~0.24R of cost
   per trade, −0.38R is mostly cost drag on a zero edge. So the finding is "these
   patterns raw, with no selectivity, lose to fees", not "these patterns can never
   work". What the existing ICT stack contributes is **selectivity** (`pickDay`,
   dedup, CISD confirmation, kill zones), not the patterns themselves — it takes
   379 validation trades where the raw families take thousands.
2. **This is the strongest evidence yet that row 20 is the whole story.** The
   causal divergence scanner is −0.365R. The `div` setup inside `scanIct` — 83%
   of which needs future bars to be detected — was the one positive contributor.
   Same pattern family: causal loses, non-causal wins. The implementations differ
   in filtering too, so this is suggestive rather than proof, but it points
   hard at the apparent ICT edge being the lookahead.

**Do not add a seventeenth candidate.** The search space has been covered at the
family level and the answer was consistent and strongly negative. The one piece
of work that can still change the verdict is closing row 20, then re-running
this exact script. If ICT's expectancy survives causal signal emission, there is
something to size. If it does not, there is nothing here to compound and the
honest product is the simulator.


---

### 36 · Money management: margin 60% and ratchet banking adopted — both measured

Two changes requested: cut deployed margin to 50-60% of the book, and add a
banking system that saves at calculated points. Both are now in, and both are
genuine improvements — but neither changes what the account does on average, and
the reason matters.

`src/lib/engine/banking.ts` implements six policies as pure functions of the
ledger, so they can be resampled without touching the engine: `none`,
`fixedStep` (the old rule), `ratchet` at two rates, `atMultiples` (bank at 2x /
3x / 5x / 8x), and `stakeFirst` (vault the whole original stake at 2x, then
ratchet). Ten tests in `banking.test.ts` cover the invariants that matter for
code that moves money: equity is conserved, cash never goes negative, nothing is
banked while underwater, the book floor holds, and a vaulted dollar is never
exposed again even when the trading book is wiped.

`scripts/ict-money.ts` (`npm run money:ict`) evaluates them properly. One
backtest path is ONE ordering of the trades, and compounding is path-dependent, so
a single dollar figure is close to meaningless. This resamples **4,000 block
bootstrap paths** (blocks of 20 consecutive trades, preserving real clustering)
over 30-day windows and reports the distribution.

Selected on median outcome and drawdown, consistent at every risk level:

```
                                     median    P5    P95   P($1k)  medDD
margin 80% / 12% risk / old step rule   $50    $5   $369     0.4%    80%   <- was
margin 60% / 6% risk / ratchet 60%      $78   $20   $252     0.0%    58%   <- now
```

So `ICT_MARGIN_PCT` 0.8 -> **0.6** and the banking rule is now **ratchet 60% of
each new equity high**, replacing "50% of every whole $100 gained" — which only
fired in $100 jumps and therefore gave back any run that peaked mid-step.
Ratchet banks continuously on the way up. It won on median and on drawdown
against all five alternatives at 6%, 12% and 25% risk.

**The requested margin reduction was the right call and the measurement agrees:**
across the sweep, moving from 80% to 50-60% margin raised the median 30-day
outcome from as low as $34 to around $80 and cut median drawdown from 87% to
~55%. With expectancy near zero, extra notional buys variance and nothing else.

**What none of it does is reach $1,000.** Across all 54 configurations tested
(3 margin levels x 3 risk levels x 6 policies):

- `P($1,000 within 30 days)` ranges from **0.0% to 2.9%**.
- **Every single configuration has a median below $100.** The range is $34-$80.
  The typical outcome is a loss.
- The best `P($1k)` — 2.9%, roughly 1 path in 34 — is margin 80% / 25% risk / no
  banking, and that same configuration has a median of **$34** and a 5th
  percentile of **$4**.

That trade-off is the whole picture: aggression raises the chance of touching
$1,000 from ~0% to ~3% by making the typical outcome twice as bad. It is buying a
lottery ticket with the median.

The cause is unchanged and is not a money-management problem: full-sample
expectancy is **-0.018R at t -0.5** (board row 34). Banking and sizing
redistribute outcomes; they cannot create them. Closing row 20 is still the only
open work that can change the verdict rather than redistribute it.
