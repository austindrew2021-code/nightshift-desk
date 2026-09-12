# BOARD — the work queue

Findings verified on commit `08993dd`, 2026-09-11, after `npm install`, by
reading the code and running every gate the repo defines. Each bot works its own
rows. **Re-confirm a row before you fix it** — the board can go stale.

Add new findings under the owning bot. Never delete a row; strike it and note the
commit that closed it, so the next bot knows it was considered.

## Priority queue

| # | Sev | Owner | Finding | Where |
| --- | --- | --- | --- | --- |
| 1 | **critical** | TIMING | NY offset hardcoded to EDT — every ICT window breaks 1 Nov 2026 | `ict.ts:3` |
| 2 | **critical** | RIGGER | CI runs no gate; nothing can stop a regression | `pages.yml` |
| 3 | **critical** | all | ~3,180 lines of engine math, zero tests | `src/lib/engine/` |
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

Recommended first three: **2** (gates), **1** (the clock), **4** (the brake that
lies). After those, everything else stays fixed once fixed.

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
