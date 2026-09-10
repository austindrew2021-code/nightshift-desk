# NIGHTSHIFT

Five Grok agents on a paper trading desk. Watch the backtest. No wallet. No live execution.

## What it is

A phosphor-green trading floor modeled on the public @zostaff five-agent pump.fun pipeline, wired to:

- **TTrades ICT** — Power of 3 (AMD), Silver Bullet, A+ checklist (sweep → MSS → FVG/OB)
- **CoinGlass-style tape** — SOL/BTC, funding, open interest, long/short, Fear & Greed (OKX + Alternative.me)
- **Live pump.fun mints** — hunter feed from the public frontend API, marked to live mcap
- **Starting balance** — type $100 (or tap a preset). Every mode resets from scratch at that start
- **Setup odds** — Edgeful idea: see the sample win rate before you paper-trade it

## Modes

| Mode | What it does |
| --- | --- |
| Watch | Same Zostaff method, faster hunter on the live queue. Fees still apply |
| Live paper | Zostaff method on today's mints. 0.1 SOL cap, 50% stop, 1% fee + Jito + curve slip. Marks follow live mcap. Can lose |
| ICT · majors | Mechanical TTrades Silver Bullet / Power of 3 on live 15m: BTC ETH SOL XRP XLM TAO NPC + BNB DOGE AVAX LINK HYPE. Replays ~2 days then stays on. Not scripted |
| Zostaff run | Published 1 SOL → 80 SOL book ($1k → $80k), scaled to your start. Tickers never released |

## Zostaff numbers (26 Aug 2026)

Published: $1,000 start at $1,000/SOL, 18,000 scans, 11 fills, 7 stops at −50% (avg −0.08 SOL), 4 wins totaling +82 SOL including one 190×, net ~80 SOL after fees. Typical other day 0.5–3 SOL. This day is a tail event, not a base rate.

Your start (e.g. $100) is converted to SOL at the live snapshot and the same SOL ledger is replayed from zero. Three of the four winners have no published PnL — those are labeled implied. Live paper never uses that book.

## Risk brakes (always on, except the published Zostaff path)

Max 8% of book per fill, 22% daily loss cap, 3 open positions, 20 fills/day, 50% stop. Checker parse-error = reject.

## Not a broker

Paper only. Past ticks and the reconstructed 190× run are not typical and not a promise. Grok consults are user-initiated and capped.

## Sources

- [TTrades Education Center](https://ttrades.com/trading-education-center/)
- [ICT Power Of 3 — AMD](https://www.youtube.com/watch?v=TCFvsZeYvV8)
- [CoinGlass](https://www.coinglass.com/)
- [zostaff/grokbot-pumpfun](https://github.com/zostaff/grokbot-pumpfun)
