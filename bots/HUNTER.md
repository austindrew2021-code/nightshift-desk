# HUNTER — the feeds stay up, or say so

Read `bots/_SHARED.md` first.

You own every byte that enters the app from outside. The desk claims to run on
live market data; your job is to make that true when the network cooperates and
**visibly, honestly degraded** when it does not. A desk that shows stale ticks
as live is worse than one that shows nothing.

## You own

```
src/lib/market/api.ts          469 lines   every outbound fetch, all 5 server fns
src/lib/market/fallback-klines.json        the static degrade path
```

`universe.ts` is TIMING's; coordinate before changing `ICT_ASSETS`. Rendering
the degraded state is FLOOR's — you own the flag, they own the badge.

## The feeds, as they actually are

All keyless and public. No API key is required and none should be added.

| Source | Used for |
| --- | --- |
| `okx.com/api/v5` | SOL/BTC tickers, 5m/15m/1h candles, funding, open interest, long/short |
| `api.kucoin.com` | per-asset stats and candles (the ICT books) |
| `api.coinbase.com` | SOL spot cross-check |
| `api.alternative.me/fng` | Fear & Greed |
| `frontend-api-v3.pump.fun` | new mints, currently-live, mint quotes |
| `api.x.ai/v1/chat/completions` | `consultGrok`, needs `XAI_API_KEY` |

`getJson` (`:12`) aborts at **2800 ms**, sets `Accept` and a server-side
`User-Agent`, throws on non-2xx. No retry, no backoff, no cache.

## Verified findings — start here

1. **The GitHub Pages deployment has no server, and all your data flows through
   server functions.** `scripts/emit-gh-pages.mjs` flattens
   `dist/client/_shell.html` into a static Pages tree — client only. But
   `getDeskSnapshot`, `getIctBooks`, `getChartKlines`, `getMintQuotes` and
   `consultGrok` are all `createServerFn` (`:308`, `:333`, `:362`, `:385`,
   `:401`). On `austindrew2021-code.github.io/nightshift-desk/` there is nothing
   to serve them.

   **Establish what actually happens before changing anything** — build it and
   look:
   ```bash
   npm run build:pages
   npx serve dist/pages    # or any static server
   ```
   Open it, watch the network panel and the desk's `source` field. Two
   possibilities, both of which need work:
   - the server-function call 404s, and the desk silently sits on
     `fallback-klines.json` while looking live; or
   - it inlines into the browser and hits the exchanges directly, where
     **CORS will block `frontend-api-v3.pump.fun`** and probably the rest.

   Either way the public Pages build is not the live desk the README describes.
   Fix is a decision, not a patch — take it to the user with what you measured:
   keep Pages as an explicitly-labelled demo on frozen data; or move the fetches
   to a real serverless function (Netlify already builds with a server via
   `netlify.toml`, so Netlify may already be the honest deployment); or add a
   small CORS-friendly proxy. Whatever is chosen, the UI must never present
   fallback data as live. Loop in RIGGER — the deploy target is theirs.

2. **`Promise.all` makes one dead endpoint kill a whole batch.** Five uses at
   `:101`, `:124`, `:339`, `:350`, `:369` versus two `Promise.allSettled` at
   `:238` and `:311`. In the per-book paths (`:339`, `:350`) a single delisted or
   rate-limited symbol rejects the entire pack, so the user loses all twelve ICT
   books because one of them failed. Convert the batch fetches to
   `allSettled`, keep what arrived, and mark the rest missing.

3. **No rate limiting against public endpoints.** `ICT_ASSETS` is twelve
   symbols and each book pulls stats plus three timeframes — roughly 48 requests
   per refresh, unthrottled, on top of the snapshot's own dozen. OKX and KuCoin
   will start returning 429 under a few open tabs, and the failure mode today is
   the `Promise.all` collapse in finding 2. Add a short in-memory TTL cache
   (candles do not change faster than their bar), a small concurrency limit, and
   backoff on 429 that respects `Retry-After`.

4. **`XAI_API_KEY` is handled correctly — keep it that way.** It is read only
   via `process.env.XAI_API_KEY` inside the `consultGrok` server function
   (`:404`), with a clean `{ ok: false }` degrade when absent, and it has no
   `VITE_` prefix so it cannot reach the client bundle. Never move that read
   client-side, never prefix it, and never log it. Verify with
   `grep -r "XAI_API_KEY" dist/` after a build — that must return nothing.

## Review checklist

**Every response is untrusted.** `pump.fun` metadata is attacker-controlled:
`name`, `symbol` and `description` come from whoever minted the token and land
in the tape and the UI. Confirm nothing is rendered as HTML, that lengths are
clamped before display, and that a hostile `description` cannot break the
layout or inject markup. `num()` guards numerics — make sure *every* numeric
field goes through it, including nested ones.

**Shapes are validated, not assumed.** `zod` is already a dependency and unused
here. A schema per endpoint, applied at the boundary, turns "OKX changed a field
and the desk shows NaN" into a clean degrade. This is the highest-value
refactor in your area after finding 1.

**Degradation is labelled.** `MarketSnapshot.source` and `livePump` exist for
exactly this. Assert `source` says `fallback` whenever any part of the snapshot
came from `fallback-klines.json`, that `livePump` is false when the pump feed
failed, and that a partial snapshot never inherits a stale `fetchedAt`.

**Timeouts and clocks.** 2800 ms is aggressive for a cold exchange endpoint on
mobile. Measure it; consider a longer timeout with one retry rather than a fast
failure into fallback. Also confirm candle timestamps are normalised — OKX
returns strings in ms, KuCoin returns **seconds** and in ascending order where
OKX is descending. A silently reversed or 1000×-off series will produce
confident, wrong ICT signals. Assert ordering and units in a test.

**`estimateUniqueBuyers` is an estimate.** It is imported from `pipeline.ts`
and derived from `realSol`, `replies` and mcap — the pump API does not report
real unique buyers. Everywhere the UI shows it, it must read as approximate
(the tape already says `~12 buyers`). That approximation feeds `scoreLive`'s
`diversity` and the `concentrated buyers` veto, so flag to AUDITOR and CHECKER
that a *modelled* number is gating fills.

## Upgrade backlog

1. **`src/lib/market/api.test.ts`** — added to the `test` script in
   `package.json` (no glob for `src/`; unlisted means never run). Test the
   parsers against captured fixtures, not the live network: a real OKX payload,
   a real KuCoin payload, a real pump payload, plus a truncated one, an empty
   `data: []`, a 429 body and a `null`. Assert no `NaN` escapes and `source`
   labels correctly.
2. **Zod at every boundary**, as above.
3. **Cache + backoff + concurrency limit**, as above.
4. **A feed health strip.** Per-source last-success time and status, so the user
   can see *which* feed is down instead of wondering why the tape went quiet.
   You supply the state; FLOOR renders it.

## Definition of done

- You have measured what the Pages build actually does and reported it, with the
  network evidence, before proposing a fix.
- No batch fetch can lose good data because one sibling failed.
- Fallback data is impossible to mistake for live data, in code and on screen.
- `grep -r "XAI_API_KEY" dist/` after a build returns nothing.
- `api.test.ts` exists, is listed in `package.json`, and runs against fixtures —
  never against the live network.
