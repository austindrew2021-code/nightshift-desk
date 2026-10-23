/**
 * Headless ICT tick for GitHub Actions. Phone is a viewer of ict-state.json.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { ICT_ASSETS, type IctAssetDef, type IctBook } from "../src/lib/engine/universe.ts";
import { fetchKucoinHotAssets, fetchKucoinAllLast, applyLiveLast } from "../src/lib/market/kucoin-hot.ts";
import { createEngine, tick, buryResurrected, ingestIct, markIct, scanPullSeat, type EngineState } from "../src/lib/engine/session.ts";
import { syncKucoinLive, expireDue, liveMode } from "../src/lib/engine/kucoin-live.ts";
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

/** Latest 200 bars decide the entry and are never held for the older page.
 *  The prior 200 (yesterday's high and low, Asia) are used if they are
 *  already back, or if they were fetched while this tick waited for the
 *  close. A slow older page does not delay the order. */
const priorCache = new Map<string, Candle[]>();

function klineUrl(symbol: string, granularityMin: number, older: boolean): string {
  const base = `https://api-futures.kucoin.com/api/v1/kline/query?symbol=${encodeURIComponent(symbol)}&granularity=${granularityMin}`;
  if (!older) return base;
  const step = granularityMin * 60 * 1000;
  const to = Date.now() - 200 * step;
  const from = to - 200 * step;
  return `${base}&from=${from}&to=${to}`;
}

function mergeCandles(pages: Candle[][]): Candle[] {
  const byT = new Map<number, Candle>();
  for (const rows of pages) for (const c of rows) byT.set(c.t, c);
  return [...byT.values()].sort((a, b) => a.t - b.t).slice(-400);
}

function warmPriors(assets: { id: string }[]) {
  for (const a of assets) {
    const sym = futInst(a.id);
    for (const g of [5, 15]) {
      const key = `${sym}:${g}`;
      void getJson(klineUrl(sym, g, true), 4000)
        .then(futCandles)
        .then((rows) => {
          if (rows.length) priorCache.set(key, rows);
        })
        .catch(() => {});
    }
  }
}

async function futPages(symbol: string, granularityMin: number): Promise<Candle[]> {
  const key = `${symbol}:${granularityMin}`;
  const latestP = getJson(klineUrl(symbol, granularityMin, false), 4000).then(futCandles).catch(() => [] as Candle[]);
  const olderP = getJson(klineUrl(symbol, granularityMin, true), 4000).then(futCandles).catch(() => [] as Candle[]);
  const cached = priorCache.get(key) ?? [];
  const latest = await latestP;
  const older = await Promise.race([
    olderP,
    new Promise<Candle[]>((resolve) => setTimeout(() => resolve(cached), cached.length ? 0 : 200)),
  ]);
  void olderP.then((rows) => {
    if (rows.length) priorCache.set(key, rows);
  });
  return mergeCandles([cached, older, latest]);
}

/** One futures request. The order uses this. Spot 15m and 1h are for the chart and can wait. */
async function fastBook(a: (typeof ICT_ASSETS)[number]): Promise<IctBook> {
  const c5 = (await futPages(futInst(a.id), 5)).filter((c) => c.t + 5 * 60 * 1000 <= Date.now() + 1500);
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

/** 15m candle, fetched only after the 5m orders are already on their way. */
async function fastBook15(a: (typeof ICT_ASSETS)[number]): Promise<IctBook> {
  const c15 = (await futPages(futInst(a.id), 15)).filter((c) => c.t + 15 * 60 * 1000 <= Date.now() + 1500);
  const last = c15.length ? c15[c15.length - 1]!.c : 0;
  return {
    id: a.id,
    symbol: a.symbol,
    name: a.name,
    last,
    change24h: 0,
    candles15: c15,
    candles5: [],
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
  if (cisdBusy(s)) return;
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

function cisdBusy(s: EngineState): boolean {
  return s.open.some((p) => p.origin === "ict" && !String(p.id).startsWith("pull"));
}

function pullWaitFresh(seen: string[], closedOpen: number): boolean {
  const prefix = `pull-wait:${closedOpen}:`;
  let at = 0;
  for (const k of seen) {
    if (!k.startsWith(prefix)) continue;
    const n = Number(k.slice(prefix.length));
    if (n > at) at = n;
  }
  return at > 0 && Date.now() - at < 15_000;
}

/** CISD for this coin has already looked. Send the pull now, not after the rest of the list. */
async function sendPull(s: EngineState, book: IctBook): Promise<void> {
  const period = 5 * 60 * 1000;
  const closedOpen = Math.floor(Date.now() / period) * period - period;
  const sawKey = `pull-saw:${book.id}:${closedOpen}`;
  if (!s.ictSeen.includes(sawKey)) s.ictSeen = [...s.ictSeen, sawKey].slice(-500);
  if (s.open.some((p) => String(p.id).startsWith("pull"))) return;
  const before = s.open.length;
  scanPullSeat(s, snapshot([book]));
  if (s.open.length === before) return;
  console.log(JSON.stringify({ t: Date.now(), pull: book.id, sinceClose: Date.now() % period }));
  try {
    await syncKucoinLive(s);
  } catch (e) {
    console.error("kucoin-live-pull", e);
  }
  writeFileSync(STATE, JSON.stringify(slim(s)));
}

/** The 20s hunter never reaches tick(). Arm the second seat on the close path it actually runs. */
async function armPullSeat(s: EngineState, assets: (typeof ICT_ASSETS)[number][]) {
  if (s.ictStyle !== "cisd") return;
  if (s.open.some((p) => String(p.id).startsWith("pull"))) return;
  const period = 5 * 60 * 1000;
  const closedOpen = Math.floor(Date.now() / period) * period - period;
  const stamp = `pull-scan:${closedOpen}`;
  const sawOf = (id: string) => `pull-saw:${id}:${closedOpen}`;
  if (s.ictSeen.includes(stamp)) return;
  const queue = assets.filter((a) => !s.ictSeen.includes(sawOf(a.id)));
  if (!queue.length) {
    s.ictSeen = [...s.ictSeen, stamp].slice(-500);
    return;
  }
  if (queue.length === assets.length && pullWaitFresh(s.ictSeen, closedOpen)) return;
  const books: IctBook[] = [];
  let saw = false;
  const puller = async () => {
    while (queue.length) {
      const a = queue.shift();
      if (!a) return;
      try {
        const b = await fastBook(a);
        if ((b.candles5?.length ?? 0) < 80) {
          if (!s.ictSeen.includes(sawOf(a.id))) s.ictSeen = [...s.ictSeen, sawOf(a.id)].slice(-500);
          continue;
        }
        if (b.candles5.some((c) => c.t === closedOpen)) saw = true;
        books.push(b);
      } catch {
        /* the next pass retries this close */
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, () => puller()));
  if (!saw) {
    s.ictSeen = [...s.ictSeen, `pull-wait:${closedOpen}:${Date.now()}`].slice(-500);
    return;
  }
  for (const b of books) {
    if (s.open.some((p) => String(p.id).startsWith("pull"))) break;
    await sendPull(s, b);
  }
  const left = assets.some((a) => !s.ictSeen.includes(sawOf(a.id)));
  if (!left) s.ictSeen = [...s.ictSeen, stamp].slice(-500);
}

/** One pass for this 5m close. The 15m entry stays valid for the whole next
 *  15 minutes, so the 15m book is read on the close and again at +5m and +10m.
 *  A price already 0.05R through is still not a fill. */
async function scanFreshClose(s: EngineState, assets: (typeof ICT_ASSETS)[number][], caught: { t: number }) {
  const period = 5 * 60 * 1000;
  const fifteen = 15 * 60 * 1000;
  const closedOpen = Math.floor(Date.now() / period) * period - period;
  if (caught.t === closedOpen) return;
  if (cisdBusy(s)) return;
  const closed15 = Math.floor(Date.now() / fifteen) * fifteen - fifteen;
  const is15 = true;
  const queue = [...assets];
  const missing: (typeof ICT_ASSETS)[number][] = [];
  const missed15: (typeof ICT_ASSETS)[number][] = [];
  const five = new Map<string, IctBook>();
  let sending: Promise<void> = Promise.resolve();
  let saw = false;
  const loadPair = async (a: (typeof ICT_ASSETS)[number]) => {
    const [r5, r15] = await Promise.allSettled([
      fastBook(a),
      is15 ? fastBook15(a) : Promise.resolve(null),
    ]);
    return {
      b5: r5.status === "fulfilled" ? r5.value : null,
      b15: r15.status === "fulfilled" ? r15.value : null,
    };
  };
  const take5 = (a: (typeof ICT_ASSETS)[number], b5: IctBook | null) => {
    if (!b5 || (b5.candles5?.length ?? 0) < 48) return false;
    if (!b5.candles5.some((c) => c.t === closedOpen)) return false;
    saw = true;
    five.set(a.id, b5);
    sending = sending.then(() => sendEarly(s, [b5]));
    return true;
  };
  const take15 = (b5: IctBook | null, b15: IctBook | null) => {
    if (!is15) return true;
    if (cisdBusy(s)) return true;
    if (!b5 || !b15?.candles15?.some((c) => c.t === closed15) || b15.candles15.length < 80) return false;
    const merged = { ...b5, candles15: b15.candles15 };
    sending = sending.then(() => sendEarly(s, [merged]));
    return true;
  };
  const worker = async () => {
    while (queue.length && !cisdBusy(s)) {
      const a = queue.shift();
      if (!a) return;
      try {
        const b5 = await fastBook(a).catch(() => null);
        const fiveOk = !!b5 && take5(a, b5);
        if (!fiveOk) missing.push(a);
        if (is15 && !cisdBusy(s)) missed15.push(a);
      } catch {
        missing.push(a);
        if (is15) missed15.push(a);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, queue.length) }, () => worker()));
  await sending;
  // KuCoin often prints the closed candle 2–4s after the bar, not at 1.5s.
  // 57% of fills first trade the entry during minute 1, so the limit has to
  // be up inside that minute. Retry until 4s, and send the instant it appears.
  const giveUp = Date.now() + 4_000;
  let pending = missing;
  let left = missed15;
  while (pending.length && !cisdBusy(s) && Date.now() < giveUp) {
    await new Promise((r) => setTimeout(r, 150));
    const again = pending;
    pending = [];
    const retry = async () => {
      while (again.length && !cisdBusy(s)) {
        const a = again.shift();
        if (!a) return;
        try {
          const { b5, b15 } = await loadPair(a);
          if (!take5(a, b5)) {
            pending.push(a);
            continue;
          }
          if (is15 && !take15(b5, b15)) {
            left.push(a);
            continue;
          }
        } catch {
          pending.push(a);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, again.length) }, () => retry()));
    await sending;
  }
  while (is15 && left.length && !cisdBusy(s) && Date.now() < giveUp) {
    await new Promise((r) => setTimeout(r, 150));
    const again = left;
    left = [];
    const retry = async () => {
      while (again.length && !cisdBusy(s)) {
        const a = again.shift();
        if (!a) return;
        try {
          const b5 = five.get(a.id) ?? (await fastBook(a));
          if ((b5.candles5?.length ?? 0) >= 48) five.set(a.id, b5);
          const b15 = await fastBook15(a);
          const book = five.get(a.id) ?? null;
          if (!take15(book, b15)) left.push(a);
        } catch {
          left.push(a);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, again.length) }, () => retry()));
    await sending;
  }
  if (saw) caught.t = closedOpen;
}

async function main() {
  const period = 5 * 60 * 1000;
  const hotP: Promise<IctAssetDef[]> = fetchKucoinHotAssets().catch(() => []);
  const untilClose = period - (Date.now() % period);
  // Pull yesterday's bars while waiting for this close, so the order itself
  // only waits on the latest page.
  warmPriors(ICT_ASSETS);
  // A tick that starts in the last 50s waits for the bar. Returning here used
  // to push the scan 15–40s past the close, and the ticker had already left.
  if (untilClose <= 50_000 && untilClose > 500) {
    await new Promise((r) => setTimeout(r, untilClose + 300));
  }
  const s = load();
  const hotReady = await Promise.race([
    hotP,
    new Promise<IctAssetDef[]>((r) => setTimeout(() => r([]), 50)),
  ]);
  const seen = new Set(ICT_ASSETS.map((a) => a.id));
  const assets = [...ICT_ASSETS];
  for (const p of [...s.open, ...s.closed]) {
    if (p.origin !== "ict" || !p.symbol || seen.has(p.symbol)) continue;
    seen.add(p.symbol);
    assets.push({ id: p.symbol, symbol: p.symbol, name: p.symbol, venue: "kucoin", instId: `${p.symbol}-USDT` });
  }
  for (const a of hotReady) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    assets.push(a);
  }
  const lock = `${STATE}.lock`;
  const heldByOther = () => {
    if (!existsSync(lock)) return false;
    const pid = Number(readFileSync(lock, "utf8"));
    // A leftover lock used to store a clock time. That is not a process, and it
    // was making the next tick skip the close.
    if (!pid || pid > 1_000_000) return false;
    try {
      process.kill(pid, 0);
      return pid !== process.pid;
    } catch {
      return false;
    }
  };
  if (heldByOther()) {
    console.log(JSON.stringify({ t: Date.now(), skip: "tick already running" }));
    return;
  }
  writeFileSync(lock, String(process.pid));
  const books: IctBook[] = [];
  let livePx: Record<string, number> = {};
  let fastOnly = false;
  try {
    buryResurrected(s, readLedger());
    try {
      await expireDue(s);
    } catch (e) {
      console.error("expire-due", e);
    }
    const caught = { t: 0 };
    const held = s.open.filter((p) => p.origin === "ict" && Date.now() - (p.liveAt || p.openedAt) > 60_000);
    if (held.length) {
      const managed: IctBook[] = [];
      for (const p of held) {
        const a = assets.find((x) => x.id === p.symbol || x.symbol === p.symbol);
        if (!a) continue;
        try {
          managed.push(await fastBook(a));
        } catch {
          /* the next tick retries the open trade */
        }
      }
      if (managed.length) markIct(s, snapshot(managed));
      try {
        await syncKucoinLive(s);
      } catch (e) {
        console.error("kucoin-live-exit", e);
      }
      writeFileSync(STATE, JSON.stringify(slim(s)));
    }
    if (!cisdBusy(s)) await scanFreshClose(s, ICT_ASSETS, caught);
    const closeIn = period - (Date.now() % period);
    const flat = !s.open.some((p) => p.origin === "ict");
    if (!(flat && closeIn < 20_000)) {
      try {
        await syncKucoinLive(s);
      } catch (e) {
        console.error("kucoin-live-fast", e);
      }
    }
    writeFileSync(STATE, JSON.stringify(slim(s)));
    const sinceClose = Date.now() % (5 * 60 * 1000);
    const untilNext = 5 * 60 * 1000 - sinceClose;
    fastOnly = sinceClose < 180_000 || untilNext < 150_000;
    if (fastOnly) {
      console.log(JSON.stringify({ t: Date.now(), fast: true, sinceClose }));
    } else {
    const hotRest = await hotP;
    for (const a of hotRest) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      assets.push(a);
    }
    for (let i = 0; i < assets.length; i += 6) {
      if (5 * 60 * 1000 - (Date.now() % (5 * 60 * 1000)) < 25_000) break;
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
    }
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* lock already cleared */
    }
  }
  if (!fastOnly) {
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
  }
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
