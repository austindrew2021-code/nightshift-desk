/**
 * Headless ICT tick for GitHub Actions. Phone is a viewer of ict-state.json.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { ICT_ASSETS, type IctBook } from "../src/lib/engine/universe.ts";
import { fetchKucoinHotAssets, fetchKucoinAllLast, applyLiveLast } from "../src/lib/market/kucoin-hot.ts";
import { createEngine, tick, buryResurrected, ingestIct, type EngineState } from "../src/lib/engine/session.ts";
import { syncKucoinLive, liveMode } from "../src/lib/engine/kucoin-live.ts";
import type { Candle, ClosedTrade, MarketSnapshot } from "../src/lib/engine/types.ts";

const STATE = process.env.ICT_STATE_PATH || "ict-state.json";
const LEDGER = process.env.ICT_CLOSED_PATH || STATE.replace(/ict-state\.json$/, "ict-closed.jsonl");
const START = Number(process.env.ICT_START_USD || 100);

function readLedger(): ClosedTrade[] {
  if (!existsSync(LEDGER)) return [];
  const out: ClosedTrade[] = [];
  for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ClosedTrade);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

function rememberCloses(closed: ClosedTrade[]) {
  const have = new Set(readLedger().map((c) => c.id));
  for (const c of closed) {
    if (c.origin !== "ict" || !c.id || have.has(c.id)) continue;
    appendFileSync(LEDGER, JSON.stringify(c) + "\n");
    have.add(c.id);
  }
}

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

function futInst(sym: string): string {
  const u = sym.toUpperCase();
  if (u === "BTC" || u === "XBT") return "XBTUSDTM";
  return `${u}USDTM`;
}

function futCandles(data: unknown): Candle[] {
  const rows = (data as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  const parsed: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const t = Number(row[0]);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    const v = Number(row[5]);
    if (!t || !o) continue;
    parsed.push({ t: t > 1e12 ? t : t * 1000, o, h, l, c, v });
  }
  parsed.sort((a, b) => a.t - b.t);
  return parsed.slice(-200);
}

/** One futures request. The order uses this. Spot 15m and 1h are for the chart and can wait. */
async function fastBook(a: (typeof ICT_ASSETS)[number]): Promise<IctBook> {
  const raw = await getJson(
    `https://api-futures.kucoin.com/api/v1/kline/query?symbol=${encodeURIComponent(futInst(a.id))}&granularity=5`,
    4000,
  );
  const c5 = futCandles(raw).filter((c) => c.t + 5 * 60 * 1000 <= Date.now() + 1500);
  const last = c5.length ? c5[c5.length - 1]!.c : 0;
  return {
    id: a.id,
    symbol: a.symbol,
    name: a.name,
    last,
    change24h: 0,
    candles15: [],
    candles5: c5,
    candles1h: [],
    source: "kucoin",
  };
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
      ictLivePend: [],
    },
  };
}

function load(): EngineState {
  /** Bump this to force a cloud $100 CISD book (phone Reset cannot wipe ict-live). */
  const BOOK = "cisd-5m-100";
  const fresh = () => {
    const s = createEngine(100, START) as EngineState & { ictBook?: string };
    s.mode = "ict";
    s.running = true;
    s.simT = Date.now();
    s.wallStarted = Date.now();
    s.ictStyle = "cisd";
    s.ictUse5m = true;
    s.ictBook = BOOK;
    s.tape = [
      {
        id: `t-reset-${Date.now()}`,
        t: Date.now(),
        kind: "note",
        symbol: "ICT",
        text: "reset · CISD 5m A+ · $100 · Judas/sweep on · Silver/15m/Playback off · phone Reset cannot wipe CLOUD — this tick did",
        tone: "warn",
      },
      ...s.tape,
    ];
    return s;
  };
  if (!existsSync(STATE)) return fresh();
  const parsed = JSON.parse(readFileSync(STATE, "utf8")) as { engine?: EngineState & { ictBook?: string } };
  const e = parsed.engine;
  if (!e || e.ictBook !== BOOK) return fresh();
  const s = createEngine(100, START);
  Object.assign(s, e, {
    mode: "ict" as const,
    running: true,
    simT: Date.now(),
    ictStyle: "cisd" as const,
    ictUse5m: true,
    ictBook: BOOK,
  });
  return s;
}

function snapshot(books: IctBook[]): MarketSnapshot {
  const sol = books.find((b) => b.id === "SOL");
  const btc = books.find((b) => b.id === "BTC");
  return {
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
}

/** First valid coin sends before the rest of the list is downloaded. */
async function sendEarly(s: EngineState, books: IctBook[]) {
  if (!books.length) return;
  if (s.open.some((p) => p.origin === "ict")) return;
  const before = (s.ictLivePend || []).length;
  ingestIct(s, snapshot(books));
  if ((s.ictLivePend || []).length === before) return;
  try {
    await syncKucoinLive(s);
  } catch (e) {
    console.error("kucoin-live-early", e);
  }
  writeFileSync(STATE, JSON.stringify(slim(s)));
}

async function main() {
  const s = load();
  const hot = await fetchKucoinHotAssets();
  const seen = new Set(ICT_ASSETS.map((a) => a.id));
  const assets = [...ICT_ASSETS];
  for (const p of [...s.open, ...s.closed]) {
    if (p.origin !== "ict" || !p.symbol || seen.has(p.symbol)) continue;
    seen.add(p.symbol);
    assets.push({ id: p.symbol, symbol: p.symbol, name: p.symbol, venue: "kucoin", instId: `${p.symbol}-USDT` });
  }
  for (const a of hot) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    assets.push(a);
  }
  const lock = `${STATE}.lock`;
  if (existsSync(lock)) {
    const age = Date.now() - Number(readFileSync(lock, "utf8") || 0);
    if (age >= 0 && age < 120_000) {
      console.log(JSON.stringify({ t: Date.now(), skip: "tick already running" }));
      return;
    }
  }
  writeFileSync(lock, String(Date.now()));
  const books: IctBook[] = [];
  let livePx: Record<string, number> = {};
  try {
    buryResurrected(s, readLedger());
    if (!s.open.some((p) => p.origin === "ict")) {
      const queue = [...assets];
      let sending: Promise<void> = Promise.resolve();
      const worker = async () => {
        while (queue.length && !s.open.some((p) => p.origin === "ict")) {
          const a = queue.shift();
          if (!a) return;
          try {
            const b = await fastBook(a);
            if ((b.candles5?.length ?? 0) < 48) continue;
            if (s.open.some((p) => p.origin === "ict")) return;
            sending = sending.then(() => sendEarly(s, [b]));
            await sending;
          } catch {
            /* one coin can fail; the rest still send */
          }
        }
      };
      await Promise.all(Array.from({ length: 12 }, () => worker()));
    }
    for (let i = 0; i < assets.length; i += 6) {
      const chunk = assets.slice(i, i + 6);
      const got = await Promise.allSettled(chunk.map(book));
      const fresh: IctBook[] = [];
      for (const r of got) {
        if (r.status === "fulfilled" && r.value.candles15.length > 20) {
          books.push(r.value);
          fresh.push(r.value);
        }
      }
      await sendEarly(s, fresh);
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
    const livePxNow = await fetchKucoinAllLast();
    livePx = livePxNow;
    for (const b of books) {
      if (livePx[b.id]! > 0) applyLiveLast(b, livePx[b.id]!);
    }
    market.solUsd = livePx.SOL || sol?.last || market.solUsd;
    market.btcUsd = livePx.BTC || btc?.last || market.btcUsd;
    s.solUsd = market.solUsd;
    tick(s, market);
    rememberCloses(s.closed);
    try {
      await syncKucoinLive(s);
    } catch (e) {
      console.error("kucoin-live", e);
    }
    writeFileSync(STATE, JSON.stringify(slim(s)));
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* lock already cleared */
    }
  }
  const klinesPath = STATE.replace(/ict-state\.json$/, "ict-klines.json");
  const klines: Record<string, { last: number; change24h: number; m15: Candle[]; m5: Candle[]; h1: Candle[] }> = {};
  for (const b of books) {
    klines[b.id] = {
      last: b.last,
      change24h: b.change24h,
      m15: (b.candles15 ?? []).slice(-120),
      m5: (b.candles5 ?? []).slice(-120),
      h1: (b.candles1h ?? []).slice(-80),
    };
  }
  writeFileSync(klinesPath, JSON.stringify({ t: Date.now(), klines }));
  const lastPath = STATE.replace(/ict-state\.json$/, "ict-last.json");
  writeFileSync(lastPath, JSON.stringify({ t: Date.now(), src: "kucoin-fut", px: livePx }));
  const open = s.open.filter((p) => p.origin === "ict");
  console.log(
    JSON.stringify({
      t: Date.now(),
      eq: Math.round(s.equityUsd * 100) / 100,
      cash: Math.round(s.cashUsd * 100) / 100,
      open: open.map((p) => `${p.side} ${p.symbol}`),
      lastTape: s.tape[0]?.text ?? "",
      books: books.length,
      live: liveMode(),
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
