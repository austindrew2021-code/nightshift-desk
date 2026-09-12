# GROK BOTS — the NIGHTSHIFT desk crew

Six working bots and one dispatcher, for reviewing, fixing and upgrading this
repo. Each bot owns a slice of the codebase, has a checklist written against
*this* code, and hands back work only when the gates pass.

The crew mirrors the desk's own five agents, so ownership is easy to remember:
the in-app `AUDITOR` watches risk, the **bot** `AUDITOR` watches the code that
computes risk.

| Bot | Owns | One-line job |
| --- | --- | --- |
| **AUDITOR** | `engine/execution.ts` `session.ts` `pipeline.ts` `zostaff.ts` `types.ts` | The ledger must not lie. Money math, fills, fees, risk brakes. |
| **TIMING** | `engine/ict.ts` `engine/universe.ts` | ICT setups are mechanical and match the published method. |
| **HUNTER** | `market/api.ts` `fallback-klines.json` | Live feeds stay up, degrade honestly, never fabricate a tick. |
| **CHECKER** | `README.md` `routes/playbook.tsx`, all user-facing copy | Adversarial veto: every claim traceable to code. |
| **FLOOR** | `components/desk/*` `routes/*.tsx` `styles.css` | The desk reads clearly on a phone at 3am. |
| **RIGGER** | `.github/workflows/` `package.json` `scripts/` `eslint.config.mjs` | Gates are green and actually enforced. |
| **DESKBOSS** | nothing — routes only | Triage, assign, integrate. Writes no product code. |

**Minimum viable crew**, if you only want to run three: **RIGGER** (make the
gates real) → **AUDITOR** (fix the money math) → **CHECKER** (make the claims
true). That ordering matters: RIGGER first, so everything after it is provable.

Every file lives in `bots/` at the repo root, **not** under `.grok/` —
`.gitignore:6` ignores `.grok/`, so anything placed there is invisible to CI, to
a fresh clone, and to Grok working from one. (That same ignore rule is why 18
tests fail; see finding 2 in `bots/RIGGER.md`.)

---

## Verified state of the repo

Measured on `08993dd`, 2026-09-11, after `npm install`. Every bot's checklist
starts from these facts — re-measure before you trust them.

```
npm run typecheck   PASS  (clean)
npm run lint        FAIL  2 errors, 12 warnings
npm test            FAIL  195 tests · 177 pass · 18 fail
npm run check:auth  (run it — not yet measured)
```

- **The 18 test failures are all in `scripts/`** — the App Builder template
  harness (`og` skill assets, `grok-pwa` icons, nitro/app-env wiring). They
  fail because `.grok/skills/og/` and `public/__grok/icon-180.png` are not in
  this repo. **Zero app code fails.** RIGGER decides: restore the assets, or
  scope those tests out of this repo's `npm test`.
- **The trading engine has no tests at all.** `src/lib/engine/` is ~3,180
  lines of financial math — `ict.ts` (1322), `session.ts` (1163),
  `zostaff.ts` (323), `types.ts` (258), `pipeline.ts` (116),
  `execution.ts` (110) — and not one test file imports any of it. Neither does
  anything test `src/lib/market/api.ts` (469). For an app whose entire value is
  that the paper ledger is honest, this is the single largest risk in the repo.
- **CI enforces nothing.** `.github/workflows/pages.yml` runs `npm ci` then
  `npm run build:pages` and deploys. It never runs typecheck, lint, or test —
  which is why 18 failures and 2 lint errors can sit on `main`.

Open findings are queued in **`bots/BOARD.md`**, already assigned.

---

## How to run the crew

### Option A — one Grok conversation per bot (recommended)

Cleanest context, and two bots can work in parallel on separate branches
because their file ownership does not overlap. For each bot, open a
conversation and paste:

```
Read bots/_SHARED.md then bots/AUDITOR.md and work the board.
Repo: austindrew2021-code/nightshift-desk
```

Swap in `TIMING.md`, `HUNTER.md`, `CHECKER.md`, `FLOOR.md`, `RIGGER.md`.

### Option B — Grok Build in this repo

`AGENTS.md` points at `bots/`, so Grok Build picks the crew up on its
own. Say which hat you want it wearing:

```
Wear the AUDITOR hat from bots/AUDITOR.md. Work the board, one PR.
```

### Option C — one session, dispatcher-led

```
Read bots/DESKBOSS.md and triage the repo. Report the queue before you
touch anything.
```

### Running two bots at once

Safe pairs — no shared files: `AUDITOR` + `FLOOR`, `TIMING` + `HUNTER`,
`RIGGER` + `CHECKER`. Unsafe: anything with `RIGGER` while it is rewriting
`package.json` scripts, and `AUDITOR` + `TIMING` both editing `session.ts`
call sites. One branch per bot, named `bot/<name>/<slug>`.

---

## The four rules that outrank everything

Repeated in `_SHARED.md`, because a bot that breaks one of these has made the
app worse no matter how good the diff looks.

1. **Paper only, forever.** Never add a wallet connect, a private key, a
   transaction signer, or a live order endpoint. Market data is read-only.
2. **Never loosen a risk brake to improve a number.** `MAX_OPEN`,
   `DAILY_LOSS_PCT`, `MAX_POS_PCT`, `MAX_SOL_PER_TRADE`, `STOP_PCT`,
   `MIN_SCORE` are a promise to the user, not tuning knobs.
3. **Never let the published Zostaff book read as a base rate.** It is one
   tail day. Keep every `implied` label on the three winners with no published
   PnL.
4. **Gates before handoff.** `npm run typecheck && npm run lint && npm test`.
   A bot that hands back red gates has not finished.

## Gate block — every bot runs this before handoff

```bash
npm run typecheck          # must be clean
npm run lint               # must be clean; --fix only for formatting
npm test                   # must not add failures; your area must gain tests
npm run check:auth         # auth invariant
npm run build              # must succeed
```
