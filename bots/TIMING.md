# TIMING — the setups must be mechanical, and on the clock

Read `bots/_SHARED.md` first.

You own the ICT engine: sweep → MSS → FVG/OB, Power of 3 (AMD), Silver Bullet,
and the session windows they all hang off. The app's pitch is that these are
**mechanical, not scripted** — your job is to keep that literally true.

## You own

```
src/lib/engine/ict.ts        1322 lines   session windows, structure, setups
src/lib/engine/universe.ts                the tradable books
```

**Do not touch** `session.ts` / `execution.ts` (AUDITOR) — if a setup needs a
different fill or stop, file it in `BOARD.md`. Copy and layout are CHECKER and
FLOOR.

## Before you start

```bash
npm install && npm run typecheck && npm test
```

Read `ict.ts` top to bottom once. It is long but it is layered: time windows
(`:1-45`), structure primitives (`swings`, `detectFvgs`, `detectObs`,
`detectBreakers`, `detectIfvg`, `cisd`, `htfBias`, `atr`, `rsiWilder`), then
`scanIct` (`:352-674`) which assembles them, then the swing/weekly scanners.

## Verified finding — fix this first

**The New York offset is hardcoded to EDT, so every ICT window breaks when US
daylight saving ends.**

```ts
// src/lib/engine/ict.ts:3
const NY_OFFSET_MS = 4 * 3600_000; // EDT in September
```

`nyParts` subtracts a flat four hours from every timestamp. That is correct
today (UTC−4, EDT) and **wrong from Sunday 1 November 2026**, when New York
moves to EST (UTC−5) and stays there until mid-March. Every window derived from
`nyHour` then sits an hour late against real New York time:

| Window | Intended NY | After 1 Nov 2026 |
| --- | --- | --- |
| London | 02:00–05:00 | 01:00–04:00 |
| NY AM / Judas | 07:00–10:00 | 06:00–09:00 |
| **Silver Bullet** | **10:00–11:00** | **09:00–10:00** |
| NY PM | 13:30–16:00 | 12:30–15:00 |
| Asia | 20:00–02:00 | 19:00–01:00 |

For a mechanical Silver Bullet — defined as exactly the 10am–11am New York
hour — this silently mis-times every signal for roughly four and a half months
a year, and `buildAsia` mis-buckets days across the boundary too. The engine
will still look busy and still produce a tape, which is what makes it dangerous.

**Fix it properly:** derive the offset from the timestamp rather than assuming
one. `Intl.DateTimeFormat` with `timeZone: "America/New_York"` gives the real
local hour, DST included, with no lookup table:

```ts
const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});
```

Cache the formatter at module scope — it is created once and reused, and
`formatToParts` is fast enough for a 300-candle scan. Then:

- Assert `nyHour` on a known EDT timestamp **and** a known EST one, plus both
  DST transition days (1 Nov 2026 and 8 Mar 2026), and the 01:00–02:00 hour
  that occurs twice on the fall-back day.
- Assert `isSilver` is true at 10:30 NY in both July and December.
- Assert `nyParts(...).day` rolls at NY midnight, not UTC midnight — the `day`
  key is what `buildAsia` and `hourRange` bucket on, so an off-by-one there
  corrupts the Asia range for the whole session.

This is the highest-value fix available in the repo. Do it first, with tests.

## Review checklist

**Windows.** `isJudas` and `isNyAm` are the *same* window (`7–10`). If that is
deliberate — the Judas swing lives inside the AM session — say so in a comment,
because it currently reads like a copy-paste. Confirm `inKill` deliberately
omits Asia. Check every boundary is half-open (`>= start && < end`) so 10:00:00
belongs to Silver Bullet and 11:00:00 does not.

**Structure primitives, one test file each.** These are pure functions over a
`Candle[]` — the easiest high-value tests in the codebase. Build small
hand-written candle fixtures where you know the answer:
- `swings(cs, 2, 2)` — a fractal needs two bars either side; assert none is
  reported inside the first or last two bars.
- `detectFvgs` — a real three-candle gap is found; a touching-wick
  non-gap is not.
- `detectObs` / `detectBreakers` / `detectIfvg` — direction is right, and a
  breaker is a *failed* order block, not a fresh one.
- `cisd` — change in state of delivery confirms only after the sweep index.
- `htfBias` returns `0` when there is genuinely no bias; a coin-flip default
  would fake confidence on every bar.
- `atr` and `rsiWilder` — compare against a known series; Wilder smoothing is
  easy to get subtly wrong on the first `n` bars.

**Lookahead is the cardinal sin.** For a signal emitted at bar `i`, nothing may
read `cs[j]` for `j > i`. This is how a backtest invents an edge that does not
exist. Grep every loop in `scanIct`, `scanSwing`, `scanSwingNative` and
`scanWeekly` for indices above the current bar, and write a test that truncates
the array at `i+1` and asserts the same signal still appears.

**Warmup.** `session.ts` filters to books with `candles15.length >= 40`, but
`atr(n=14)`, `rsiWilder(n=14)`, `swings` and `htfBias` each need their own
warmup. Assert no signal is emitted before every indicator it depends on is
actually warm — a signal on bar 3 is noise wearing a setup's name.

**Stops and targets.** `twoR` builds the target from entry, stop and optionally
`erl`. Assert stop is always on the losing side of entry for both directions,
that a `long` target is above entry and a `short` target below, and that
`stopPad` (`:416`, `(nine.h - nine.l) * 0.08 || entry * 0.002`) cannot produce a
zero-width or inverted stop when the 9am bar is a doji.

**Dead code.** Lint flags `equalPool` (`:694`) and `impulseRange` (`:715`) as
unused. Either wire them into `scanIct` — equal highs/lows are a real ICT draw
on liquidity and their absence is a genuine gap in the method — or delete them.
Do not silence them with an underscore.

**`styleAllows`.** `IctStyle` is `all | sweep | scalp | swing`. Assert every
`SetupKind` the scanners can emit is reachable under at least one style, and
that `all` genuinely allows all of them. A setup that no style admits is code
that can never fire.

## Upgrade backlog

1. **`src/lib/engine/ict.test.ts`**, added to the `test` script in
   `package.json` (there is no glob for `src/` — an unlisted file never runs).
   Timezone first, then the structure primitives, then the lookahead guard.
2. **Honest per-setup stats.** `SetupOdds` feeds the "see the win rate before
   you paper-trade it" promise. Compute it from real replayed trades, carry the
   sample size, and refuse to show a rate under ~20 trades. Coordinate the
   display with FLOOR.
3. **Name the reason on every signal.** An ICT signal should carry the sweep it
   took, the level it swept, and the FVG or OB it entered on, so the tape can
   say *why*. This is what makes the desk feel mechanical rather than scripted.
4. **Multi-timeframe alignment.** `htfBias` exists but confirm every entry
   actually respects it, and that 1h bias is derived from 1h candles rather
   than folded 15m (`foldHour` at `:742` — check which one feeds bias).

## Definition of done

- The DST fix is in, with tests covering both offsets and both transition days.
- `ict.test.ts` exists, is listed in `package.json`, and passes.
- No lookahead anywhere; you can point at the test that proves it.
- Lint's two unused-function warnings in `ict.ts` are resolved by wiring or
  deleting, not by renaming.
- Setups you changed are described in the PR body in the desk voice, naming
  what a user will now see fire differently.
