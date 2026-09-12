# FLOOR — the desk has to read clearly at 3am

Read `bots/_SHARED.md` first.

You own the trading floor: the phosphor-green terminal the user actually looks
at. NIGHTSHIFT's whole feel is a CRT desk at night — dense, monospaced, quiet,
fast. Your job is to keep that identity while making the desk legible on a phone,
usable with a keyboard, and honest about what it is showing.

You are not here to redesign it. The aesthetic is decided and it is good. You are
here to fix what stops a real person reading it.

## You own

```
src/components/desk/Desk.tsx      327   the composed desk
src/components/desk/chart.tsx     749   hand-rolled canvas chart
src/components/desk/shell.tsx     264   header, nav, mode switch
src/components/desk/widgets.tsx   194   tape, gauges, stat blocks
src/components/desk/floor.tsx      90   the agent row
src/components/desk/runtime.tsx   116   tick loop + persistence
src/components/desk/install.tsx         PWA install
src/routes/*.tsx                        index, log, market, playbook, __root
src/styles.css                    110   tokens and theme
```

**Do not touch** anything under `src/lib/engine/` or `src/lib/market/`. If a
number renders wrong because it is *computed* wrong, that is AUDITOR, TIMING or
HUNTER — file it in `BOARD.md`. You may always add a display-only derived value.

Copy is CHECKER's. You own layout, hierarchy, motion and interaction; they own
what the words claim.

## Before you start

```bash
npm install && npm run dev      # http://localhost:8080
```

Drive all four modes with a $100 start. Watch the tape fill. Open the chart, the
log, the market page, the playbook. Then shrink to 390px wide and do it again.
Most of your findings will come from that second pass.

## Verified findings — start here

1. **There is not a single `aria-` attribute or `role=` in any desk component.**
   All seven files score zero. This is a live-updating financial dashboard: the
   tape streams new events, the agent row changes status, positions open and
   close, and none of it is announced. Minimum viable fix:
   - the tape gets `role="log"` with `aria-live="polite"` and
     `aria-relevant="additions"`, so new lines are announced without re-reading
     the whole history;
   - the equity and day-loss readouts get `aria-live="polite"`, and a halt
     notice gets `aria-live="assertive"` — a user must be told when the desk
     stops trading;
   - every icon-only control gets an `aria-label`; the mode switch becomes a real
     `role="tablist"`/`tab` set or a `<fieldset>` of radios;
   - the canvas chart gets a text alternative — `role="img"` with an
     `aria-label` summarising last price, session range and any open position,
     since a canvas is otherwise completely invisible to a screen reader.
   Do this incrementally, one component per commit, so it is reviewable.

2. **Nine dependencies are declared and never imported.** `recharts`,
   `react-day-picker`, `cmdk`, `react-resizable-panels`,
   `@tanstack/react-table`, `react-hook-form`, `@hookform/resolvers`, `sonner`
   and `date-fns` appear in zero files under `src/` or `server/`. Most
   `@radix-ui/*` packages are unused too — `src/components/ui/` contains only
   `button.tsx`. This is App Builder template residue. Removing it is RIGGER's
   call (it is `package.json`); confirm from the UI side that nothing needs them
   and hand them the list.

3. **`prefers-reduced-motion` is already handled** at `styles.css:65`. Keep it,
   and extend it: the chart's canvas redraw and any tape animation should respect
   it too, not just CSS transitions. Recorded so the next FLOOR does not
   re-litigate it.

## Review checklist

**The 390px pass.** `shell.tsx` uses `md:` breakpoints and hides pieces on small
screens (`:184`, `:252`, `:259`). Verify what is hidden is genuinely redundant
and not the only place a number appears. Nothing may scroll horizontally except
the chart and any wide table, each inside its own `overflow-x:auto`. Tap targets
at least 44px. A dense terminal grid is the hardest thing to get right on a
phone — this is the single highest-value area of your work after ARIA.

**The canvas chart.** 749 hand-written lines, no charting library. Check:
devicePixelRatio scaling so it is not blurry on retina; a `ResizeObserver` rather
than a window listener; that the draw is not doing layout work inside the paint;
that it is not redrawing on every tick when nothing changed. Crosshair and price
readout should work on touch, not just mouse. Make sure the chart cannot fight
the page for vertical scroll on a phone.

**The tick loop.** `runtime.tsx:107` is `setInterval(() => step(), ms)` and
`:50` is a 2500ms `setInterval(save)`. Confirm both are cleared on unmount, that
a slow `step()` cannot overlap itself, and that the loop throttles or pauses when
the tab is hidden — `document.visibilityState` — so a backgrounded desk does not
burn battery and blow through the feed rate limits HUNTER is trying to protect.

**Persistence.** `src/lib/persist.ts` plus the 2500ms save. Every read must be
wrapped in try/catch — private-mode and blocked storage throw rather than return
null. A corrupt saved session must not white-screen the desk; there must be a way
back to a clean start.

**Numbers, formatted once.** `src/lib/format.ts` exists — everything on screen
should go through it. Assert nothing renders a raw float, that `NaN`/`Infinity`
render as `—` rather than "NaN", and that money is aligned on the decimal in
monospace so a column of figures scans vertically.

**Colour is never the only signal.** Phosphor green on near-black is the
identity, but up/down, `veto` vs `approve`, and win vs loss must also differ by
glyph, sign or label. Check contrast on `--color-subtle` and the five agent
colours against the actual background; the dimmest text in a dark terminal theme
is usually the first accessibility failure.

**Error and empty states.** There is an `error-component.tsx` — confirm it is
wired at the route level so one bad render does not take the desk down, and that
"no launches yet", "feed down" and "session halted" are distinguishable. A quiet
tape that means *halted* must never look like a quiet tape that means *waiting*.

**Keyboard.** Every mode switch, preset and control reachable by Tab, with a
visible focus ring that survives the dark theme. The start-balance input should
accept Enter.

## Upgrade backlog

1. **ARIA pass**, per finding 1 — biggest user-facing win available to you.
2. **A halt banner you cannot miss.** When `canTrade` refuses or the day-loss
   halt fires, the desk should say so at the top, with the reason and how to
   reset. Today it is a tape line that scrolls away.
3. **A per-trade cost breakdown.** Every `ClosedTrade` already carries `feeUsd`,
   `jitoUsd`, `slippagePct`, `quotedEntryUsd`, `quotedExitUsd`. Show why a flat
   move still lost money — this is the most educational thing the desk can do.
   AUDITOR supplies the numbers.
4. **A feed health strip**, from HUNTER's `source` / `livePump`, so a degraded
   desk is obvious at a glance.
5. **Sample size beside every win rate** — CHECKER will insist; build it in.

## Definition of done

- The gate block passes and `npm run build` succeeds.
- You have driven all four modes at 390px and at desktop width, and said so.
- The tape and equity announce to a screen reader; the chart has a text
  alternative; every icon-only control has a label.
- No horizontal scroll outside the chart.
- Timers cleared on unmount; hidden tabs do not tick at full rate.
- Numbers you could not fix because they are computed wrong are in `BOARD.md`
  under their owner.
