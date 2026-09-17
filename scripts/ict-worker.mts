/**
 * Headless ICT tick for GitHub Actions. Phone is a viewer of ict-state.json.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ICT_ASSETS, type IctBook } from "../src/lib/engine/universe.ts";
import { fetchKucoinHotAssets } from "../src/lib/market/kucoin-hot.ts";
import { createEngine, tick, type EngineState } from "../src/lib/engine/session.ts";
import type { Candle, MarketSnapshot } from "../src/lib/engine/types.ts";

const STATE = process.env.ICT_STATE_PATH || "ict-state.json";
const START = Number(process.env.ICT_START_USD || 100);

async function getJson(url: string, timeout = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "NightshiftDesk/cloud" },
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function kucoinCandles(data: unknown): Candle[] {
  const rows = (data as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  const parsed: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const t = Number(row[0]);
    const o = Number(row[1]);
    const close = Number(row[2]);
    const h = Number(row[3]);
    const l = Number(row[4]);
    const v = Number(row[5]);
    if (!t || !o) continue;
    parsed.push({ t: t > 1e12 ? t : t * 1000, o, h, l, c: close, v });
  }
  parsed.sort((a, b) => a.t - b.t);
  return parsed.slice(-200);
}

async function book(a: (typeof ICT_ASSETS)[number]): Promise<IctBook> {
  const [stats, m15, m5, h1] = await Promise.all([
    getJson(`https://api.kucoin.com/api/v1/market/stats?symbol=${encodeURIComponent(a.instId)}`),
    getJson(`https://api.kucoin.com/api/v1/market/candles?type=15min&symbol=${encodeURIComponent(a.instId)}`),
    getJson(`https://api.kucoin.com/api/v1/market/candles?type=5min&symbol=${encodeURIComponent(a.instId)}`),
    getJson(`https://api.kucoin.com/api/v1/market/candles?type=1hour&symbol=${encodeURIComponent(a.instId)}`),
  ]);
  const row = (stats as { data?: Record<string, string> })?.data;
  const last = Number(row?.last) || 0;
  const change = Number(row?.changeRate) || 0;
  const c15 = kucoinCandles(m15);
  const c5 = kucoinCandles(m5);
  const c1 = kucoinCandles(h1);
  if (c15.length) {
    const z = c15[c15.length - 1]!;
    if (last) {
      z.c = last;
      z.h = Math.max(z.h, last);
      z.l = Math.min(z.l, last);
    }
  }
  return {
    id: a.id,
    symbol: a.symbol,
    name: a.name,
    last,
    change24h: change,
    candles15: c15,
    candles5: c5,
    candles1h: c1,
    source: "kucoin",
  };
}

function slim(s: EngineState) {
  return {
    t: Date.now(),
    engine: {
      ...s,
      liveQueue: [],
      heatmap: s.heatmap.slice(0, 192),
      tape: s.tape.slice(0, 60),
      closed: s.closed.slice(0, 80),
      equity: s.equity.slice(-120),
      ictTrades: s.ictTrades.slice(0, 80),
      ictSeen: s.ictSeen.slice(-400),
      seenMints: [],
      zPlan: [],
    },
  };
}

function load(): EngineState {
  if (!existsSync(STATE)) {
    const s = createEngine(100, START);
    s.mode = "ict";
    s.running = true;
    s.simT = Date.now();
    s.tape = [
      {
        id: `t-cloud-${Date.now()}`,
        t: Date.now(),
        kind: "note",
        symbol: "CLOUD",
        text: "GitHub worker · every 5m · phone is a viewer · lock/off OK",
        tone: "up",
      },
      ...s.tape,
    ];
    return s;
  }
  const parsed = JSON.parse(readFileSync(STATE, "utf8")) as { engine?: EngineState };
  const e = parsed.engine;
  const s = createEngine(100, START);
  if (!e) {
    s.mode = "ict";
    s.running = true;
    return s;
  }
  Object.assign(s, e, { mode: "ict" as const, running: true, simT: Date.now() });
  return s;
}

async function main() {
  const hot = await fetchKucoinHotAssets();
  const assets = [...ICT_ASSETS, ...hot.filter((a) => !ICT_ASSETS.some((c) => c.id === a.id))];
  const books: IctBook[] = [];
  for (let i = 0; i < assets.length; i += 6) {
    const chunk = assets.slice(i, i + 6);
    const got = await Promise.allSettled(chunk.map(book));
    for (const r of got) {
      if (r.status === "fulfilled" && r.value.candles15.length > 20) books.push(r.value);
    }
  }
  const sol = books.find((b) => b.id === "SOL");
  const btc = books.find((b) => b.id === "BTC");
  const market: MarketSnapshot = {
    fetchedAt: Date.now(),
    solUsd: sol?.last || 100,
    btcUsd: btc?.last || 0,
    solChange24h: sol?.change24h || 0,
    btcChange24h: btc?.change24h || 0,
    fundingSol: 0,
    oiSolUsd: 0,
    longShortSol: 1,
    fearGreed: 50,
    fearLabel: "Neutral",
    candles15: sol?.candles15 ?? [],
    candles1h: sol?.candles1h ?? [],
    candles5: sol?.candles5 ?? [],
    launches: [],
    livePump: false,
    books,
    source: "kucoin",
  };
  const s = load();
  s.solUsd = market.solUsd;
  tick(s, market);
  writeFileSync(STATE, JSON.stringify(slim(s)));
  const open = s.open.filter((p) => p.origin === "ict");
  console.log(
    JSON.stringify({
      t: Date.now(),
      eq: Math.round(s.equityUsd * 100) / 100,
      cash: Math.round(s.cashUsd * 100) / 100,
      open: open.map((p) => `${p.side} ${p.symbol}`),
      lastTape: s.tape[0]?.text ?? "",
      books: books.length,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
