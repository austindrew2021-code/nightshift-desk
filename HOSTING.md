# Hosting NIGHTSHIFT so it stays up

The desk needs a **server**, not just static files. Five things run server-side:
`getDeskSnapshot`, `getIctBooks`, `getChartKlines`, `getMintQuotes` and
`consultGrok` (`src/lib/market/api.ts`). Host it statically and the live feeds
and the Grok consult both stop working.

Pick a host with `NITRO_PRESET`; no code change needed.

## Vercel — recommended, free, already the default

Hobby is free on an ongoing basis rather than a credit balance that runs out,
and `vite.config.ts` already builds with the `vercel` preset when `NETLIFY` is
unset. Verified: `npm run build` emits `.vercel/output/` with
`functions/__server.func` and Build Output API v3, which Vercel detects on its
own.

1. vercel.com → Add New → Project → import `austindrew2021-code/nightshift-desk`
2. Framework preset **Other**. Build `npm run build`. Leave output dir blank —
   the Build Output API in `.vercel/output/` takes over.
3. Node 22 (Settings → General → Node.js Version).
4. Optional: add `XAI_API_KEY` under Settings → Environment Variables to turn on
   the Grok consult. Without it `consultGrok` returns
   `{ ok: false, error: "Grok is not available in this environment" }`, which is
   the correct degrade — nothing else breaks.
5. Deploy. Every push to the branch redeploys.

Hobby is for non-commercial projects. If NIGHTSHIFT ever becomes commercial,
move to Cloudflare below or a paid tier.

## Cloudflare Workers — the other strong free option

100k requests/day on the free plan, no sleeping.

```bash
NITRO_PRESET=cloudflare_module npm run build   # -> .output
npx wrangler deploy
```

Note the preset name: bare `cloudflare` is **not** valid and fails with
`Nitro entry is missing!`. Verified names in this nitro version are
`cloudflare_module` (Workers, outputs `.output`) and `cloudflare_pages`
(outputs `dist`).

Set `XAI_API_KEY` with `npx wrangler secret put XAI_API_KEY`. The build is
verified; the **runtime** is not — Workers use a different fetch runtime than
Node, so test the OKX and pump.fun calls from a deployed Worker before you rely
on it.

## A box you control — never sleeps, no platform limits

```bash
NITRO_PRESET=node npm run build
PORT=3000 node .output/server/index.mjs
```

Verified end to end here: `/` returns 200, `/manifest.webmanifest` returns 200
as `application/manifest+json` (nitro sets the type itself, so the
`netlify.toml` header block is only needed on Netlify) and the icons return 200.
This is the most reliable "leave it running" option because nothing throttles or
sleeps it.

Put it behind a process manager so it survives reboots and crashes:

```bash
npm i -g pm2
NITRO_PRESET=node npm run build
pm2 start .output/server/index.mjs --name nightshift --time
pm2 save && pm2 startup            # run the command it prints
```

Fly.io and Railway both have small free/cheap tiers that suit this. Render's
free web services sleep when idle, which defeats "leave it running".

## GitHub Pages — what you have now, and why the desk looks dead on it

`npm run build:pages` produces a static SPA (`scripts/emit-gh-pages.mjs`
flattens `dist/client`). There is no server, so:

- every `createServerFn` call has nothing to answer it — the desk falls back to
  the frozen candles in `src/lib/market/fallback-klines.json`;
- `consultGrok` can never run;
- the browser cannot call the exchanges directly either, because
  `frontend-api-v3.pump.fun` does not send CORS headers.

Keep Pages only as a labelled demo on frozen data. It is not the live desk.

## Keeping it alive

- **Do not** rely on a browser tab staying open. `runtime.tsx` ticks with
  `setInterval` in the page, so the desk only advances while a tab is open and
  its ledger lives in that browser via `src/lib/persist.ts`.
- A tab left open on a phone gets suspended by iOS/Android within minutes.
  Installed as a PWA it survives longer, but it is still not a server-side
  runner.
- If you want the desk trading while nothing is open, that is a real feature and
  a different shape: move the tick loop into a scheduled server job writing to
  the database that already exists (`src/lib/db.ts`, `migrations/`). Not built
  yet — it is the largest single item not on `bots/BOARD.md`.

## Free-tier reality check

| Host | Free | Server | Sleeps |
| --- | --- | --- | --- |
| Vercel Hobby | ongoing, non-commercial | yes | no |
| Self-host + pm2 | your box | yes | no |
| Cloudflare Workers | 100k req/day | yes | no |
| GitHub Pages | yes | **no** | n/a |
| Fly.io / Railway | small allowance | yes | no |
| Render free | yes | yes | **yes** |
| Netlify | credits — yours ran out | yes | no |


## Verified on 2026-09-12

Build presets, run against this commit:

```
NITRO_PRESET unset (vercel)   OK  -> .vercel/output/functions/__server.func
NITRO_PRESET=cloudflare_module OK  -> .output
NITRO_PRESET=cloudflare_pages  OK  -> dist
NITRO_PRESET=node              OK  -> .output/server/index.mjs
NITRO_PRESET=cloudflare        FAIL  "Nitro entry is missing!"
```

`npm run build` also runs `db:migrate`, which prints
`DATABASE_URL not set — skipping` and exits 0. It will not fail a deploy that
has no database.
