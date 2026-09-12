/**
 * ICT probe — run the ICT engine over live candle history and report what it
 * finds, with no clock and no UI in the way.
 *
 * Why this exists: in the app, ICT mode only surfaces a closed trade whose open
 * AND close both fall inside the last 45 minutes (session.ts:846-848), and only
 * scans inside a kill zone. So outside London / NY AM / Silver Bullet / NY PM
 * the desk is legitimately quiet, and you cannot tell a quiet desk from a broken
 * one by watching it. This bypasses both filters.
 *
 *   npm run probe:ict
 *   npm run probe:ict -- 1H        # other bar: 5m 15m 1H
 *
 * Signals here are what scanIct finds; they are not paper trades and carry no
 * PnL. Paper fills still go through session.ts with every risk brake applied.
 */
import {
  scanIct, parseKlines, nyHour, nyParts,
  isSilver, isLondon, isNyAm, isNyPm, isAsia,
} from "../src/lib/engine/ict.ts";
import { ICT_ASSETS } from "../src/lib/engine/universe.ts";
import type { Candle } from "../src/lib/engine/types.ts";

const BAR = process.argv[2] ?? "15m";
const now = Date.now();

function zone(t: number): string {
  if (isSilver(t)) return "silver";
  if (isLondon(t)) return "london";
  if (isNyAm(t)) return "ny-am";
  if (isNyPm(t)) return "ny-pm";
  if (isAsia(t)) return "asia";
  return "off";
}

console.log(`bar=${BAR}  NY now ${nyHour(now).toFixed(2)}h  zone=${zone(now)}  ` +
  `kill=${isLondon(now) || isNyAm(now) || isSilver(now) || isNyPm(now)}`);

/** Mirrors api.ts:43-47 — OKX returns newest-first and parseKlines does NOT sort. */
async function okx(instId: string, bar: string, limit = 300): Promise<Candle[]> {
  const r = await fetch(
    `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`,
  );
  if (!r.ok) throw new Error(`http ${r.status}`);
  const j = (await r.json()) as { data?: string[][] };
  const rows = (j.data ?? []).map((x) => x.slice(0, 6).map(Number)).reverse();
  return parseKlines(rows as number[][]);
}

const bySetup = new Map<string, number>();
const byZone = new Map<string, number>();
const rows: string[] = [];
let total = 0;
let ordering = 0;

for (const a of ICT_ASSETS) {
  if (a.venue !== "okx") { rows.push(`${a.id.padEnd(5)} skipped — ${a.venue}`); continue; }
  try {
    const cs = await okx(a.instId, BAR);
    if (cs.length < 40) { rows.push(`${a.id.padEnd(5)} only ${cs.length} bars — under the 40-bar floor`); continue; }
    for (let i = 1; i < cs.length; i++) if (cs[i].t <= cs[i - 1].t) ordering++;

    const sigs = scanIct(cs);
    total += sigs.length;
    for (const s of sigs) {
      bySetup.set(s.setup, (bySetup.get(s.setup) ?? 0) + 1);
      const z = zone(s.t ?? cs[cs.length - 1].t);
      byZone.set(z, (byZone.get(z) ?? 0) + 1);
    }
    const span = (cs[cs.length - 1].t - cs[0].t) / 3600_000;
    rows.push(
      `${a.id.padEnd(5)} ${String(cs.length).padStart(3)} bars ${span.toFixed(0).padStart(4)}h  ` +
      `${String(sigs.length).padStart(3)} sig  ${sigs.slice(-4).map((s) => s.setup).join(",")}`,
    );
  } catch (e) {
    rows.push(`${a.id.padEnd(5)} FETCH FAIL — ${(e as Error).message}`);
  }
}

console.log("\n" + rows.join("\n"));
console.log(`\nTOTAL ${total} signals`);
console.log("setup:", [...bySetup].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(" "));
console.log("zone: ", [...byZone].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(" "));

if (ordering > 0) console.log(`\n!! ${ordering} out-of-order bars — candles are not ascending; ICT output is unsafe`);
if (total === 0) console.log("\n!! zero signals across every book — that is an engine problem, not a quiet market");

// Window sanity: a Silver Bullet must sit in the 10-11 NY hour, by definition.
const silverOk = (t: number) => { const h = nyParts(t).h; return h === 10; };
console.log(`\nnote: NY offset is hardcoded to EDT (ict.ts:3). Today that is correct;`);
console.log(`      from 1 Nov 2026 every window above is an hour late. See bots/TIMING.md.`);
void silverOk;
