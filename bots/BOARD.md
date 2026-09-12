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
