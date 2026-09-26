/**
 * KuCoin USDT-M isolated live probe. Off unless ICT_LIVE=1 and keys exist.
 * Paper book is untouched. 1 seat, 18% of min(wallet, KUCOIN_LIVE_USD).
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import type { EngineState, Position, Side } from "./types";
import { ICT_HARD_RISK_PCT, ictLiqPct } from "./types";
import { ictLivePend } from "./live-pend";

const BASE = "https://api-futures.kucoin.com";
const LIVE_FILE = process.env.ICT_LIVE_STATE || "ict-live-orders.json";
const LOG = process.env.ICT_LIVE_LOG || "ict-live-log.jsonl";

export type LiveMode = "off" | "dry" | "on";

export function liveMode(): LiveMode {
  const v = (process.env.ICT_LIVE || "0").toLowerCase();
  if (v === "1" || v === "on" || v === "true") return "on";
  if (v === "dry" || v === "paper") return "dry";
  return "off";
}

function keys() {
  return {
    key: process.env.KUCOIN_API_KEY || "",
    secret: process.env.KUCOIN_API_SECRET || "",
    pass: process.env.KUCOIN_API_PASSPHRASE || "",
    version: process.env.KUCOIN_KEY_VERSION || "2",
  };
}

function liveUsd() {
  return Math.max(20, Math.min(200, Number(process.env.KUCOIN_LIVE_USD || 50)));
}

function liveSeats() {
  return 1;
}

type LiveSeat = {
  paperId: string;
  symbol: string;
  inst: string;
  side: Side;
  entry: number;
  stop: number;
  lots: number;
  lotsLeft: number;
  lev: number;
  entryOid?: string;
  tpOid?: string;
  slOid?: string;
  partialed: boolean;
  openedAt: number;
};

type LiveBook = { seats: LiveSeat[] };

function loadBook(): LiveBook {
  if (!existsSync(LIVE_FILE)) return { seats: [] };
  try {
    return JSON.parse(readFileSync(LIVE_FILE, "utf8")) as LiveBook;
  } catch {
    return { seats: [] };
  }
}

function saveBook(b: LiveBook) {
  writeFileSync(LIVE_FILE, JSON.stringify(b, null, 2));
}

function log(row: Record<string, unknown>) {
  appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...row }) + "\n");
  console.log("kucoin-live", JSON.stringify(row));
}

function sign(secret: string, ts: string, method: string, path: string, body: string) {
  return createHmac("sha256", secret)
    .update(ts + method + path + body)
    .digest("base64");
}

async function kucoin<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { key, secret, pass, version } = keys();
  const ts = Date.now().toString();
  const payload = body ? JSON.stringify(body) : "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "KC-API-KEY": key,
    "KC-API-SIGN": sign(secret, ts, method, path, payload),
    "KC-API-TIMESTAMP": ts,
    "KC-API-PASSPHRASE":
      version === "1"
        ? pass
        : createHmac("sha256", secret).update(pass).digest("base64"),
    "KC-API-KEY-VERSION": version,
    "User-Agent": "NightshiftDesk/live",
  };
  const res = await fetch(BASE + path, { method, headers, body: payload || undefined });
  const json = (await res.json()) as { code?: string; msg?: string; data?: T };
  if (json.code !== "200000") throw new Error(json.msg || json.code || `http ${res.status}`);
  return json.data as T;
}

type Contract = { symbol: string; multiplier: number; lotSize: number; tickSize: number; maxLeverage: number };

const contractCache = new Map<string, Contract>();

async function contractFor(sym: string): Promise<Contract | null> {
  const want = instOf(sym);
  if (contractCache.has(want)) return contractCache.get(want)!;
  const res = await fetch(BASE + "/api/v1/contracts/active", {
    headers: { Accept: "application/json", "User-Agent": "NightshiftDesk/live" },
  });
  const json = (await res.json()) as { data?: Record<string, unknown>[] };
  for (const r of json.data || []) {
    const symbol = String(r.symbol || "");
    const c: Contract = {
      symbol,
      multiplier: Number(r.multiplier) || 1,
      lotSize: Number(r.lotSize) || 1,
      tickSize: Number(r.tickSize) || 0.0001,
      maxLeverage: Number(r.maxLeverage) || 20,
    };
    contractCache.set(symbol, c);
  }
  return contractCache.get(want) || null;
}

function instOf(sym: string): string {
  const u = sym.toUpperCase();
  if (u === "BTC" || u === "XBT") return "XBTUSDTM";
  if (u === "BONK") return "1000BONKUSDTM";
  if (u === "PEPE") return "1000PEPEUSDTM";
  if (u === "FLOKI") return "1000FLOKIUSDTM";
  return `${u}USDTM`;
}

function pxStr(px: number, tick: number): string {
  if (!(tick > 0)) return String(px);
  const n = Math.round(px / tick) * tick;
  const d = Math.min(8, Math.max(0, Math.round(-Math.log10(tick))));
  return n.toFixed(d);
}

function lotsFor(notional: number, px: number, c: Contract) {
  const raw = notional / Math.max(1e-12, px * c.multiplier);
  const n = Math.floor(raw / c.lotSize) * c.lotSize;
  return Math.max(c.lotSize, n);
}

async function usdtEquity(): Promise<number> {
  const d = await kucoin<{ availableBalance?: string; accountEquity?: string }>(
    "GET",
    "/api/v1/account-overview?currency=USDT",
  );
  return Number(d?.availableBalance || d?.accountEquity || 0);
}

async function place(mode: LiveMode, body: Record<string, unknown>) {
  log({ kind: "order", mode, body: { ...body, clientOid: body.clientOid } });
  if (mode !== "on") return { orderId: `dry-${body.clientOid}`, dry: true };
  return kucoin<{ orderId?: string }>("POST", "/api/v1/orders", body);
}

async function placeStop(mode: LiveMode, body: Record<string, unknown>): Promise<string> {
  let last = "";
  for (let i = 0; i < 3; i++) {
    try {
      const id = String((await place(mode, { ...body, clientOid: oid("sl") })).orderId || "");
      if (id) return id;
    } catch (e) {
      last = String(e);
      log({ kind: "sl-fail", try: i + 1, err: last });
    }
    if (i < 2) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return "";
}

async function cancel(mode: LiveMode, id?: string) {
  if (!id || id.startsWith("dry-")) return;
  if (mode !== "on") return;
  try {
    await kucoin("DELETE", `/api/v1/orders/${id}`);
  } catch (e) {
    log({ kind: "cancel-fail", id, err: String(e) });
  }
}

function oid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function push(s: EngineState, text: string, tone: "up" | "warn" | "mute" | "down" = "warn") {
  s.tape = [
    {
      id: `t-live-${Date.now()}`,
      t: s.simT || Date.now(),
      kind: "note",
      symbol: "LIVE",
      text,
      tone,
    },
    ...s.tape,
  ].slice(0, 80);
}

function releasePaper(s: EngineState, p: Position, why: string) {
  const fee = Math.max(0, Number(p.sizeUsd) * 0.0006);
  s.cashUsd = Number(s.cashUsd) + fee;
  s.stats.feesUsd = Math.max(0, Number(s.stats.feesUsd) - fee);
  s.open = s.open.filter((x) => x.id !== p.id);
  s.ictLivePend = (s.ictLivePend || []).filter((x) => x.id !== p.id);
  s.stats.openCount = s.open.length;
  push(s, `not a fill ${p.symbol} · ${why} · seat free · not a halt`, "warn");
}

async function enter(s: EngineState, p: Position, mode: LiveMode, book: LiveBook) {
  if (book.seats.length >= liveSeats()) {
    push(s, `LIVE skip ${p.symbol} · seat already full`, "warn");
    if (mode === "on") releasePaper(s, p, "seat full");
    return;
  }
  const c = await contractFor(p.symbol);
  if (!c) {
    log({ kind: "skip", why: "no-contract", symbol: p.symbol });
    push(s, `LIVE dry skip ${p.symbol} · no ${instOf(p.symbol)} contract`, "warn");
    if (mode === "on") releasePaper(s, p, "no contract");
    return;
  }
  let eq = liveUsd();
  if (mode === "on") {
    try {
      eq = Math.min(liveUsd(), await usdtEquity());
    } catch (e) {
      log({ kind: "equity-fail", err: String(e) });
      push(s, `LIVE equity fail · ${String(e).slice(0, 80)}`, "down");
      releasePaper(s, p, "equity fail");
      return;
    }
  }
  const riskUsd = eq * ICT_HARD_RISK_PCT;
  const stopPct = Math.max(1e-6, p.stopPct || Math.abs(p.entryUsd - (p.stopUsd || p.entryUsd)) / p.entryUsd);
  if (eq < 20 || riskUsd < 2) {
    log({ kind: "skip", why: "no-funds", eq, riskUsd });
    push(s, `LIVE skip ${p.symbol} · wallet $${eq.toFixed(2)} (need ≥$20 on futures)`, "warn");
    if (mode === "on") releasePaper(s, p, "wallet");
    return;
  }
  const asked = Math.min(40, Math.max(1, Number(String(p.note.match(/(\d+)x/)?.[1] || 40))));
  const lev = Math.min(asked, c.maxLeverage || asked);
  const notional = Math.min(riskUsd / stopPct, eq * lev * 0.85);
  const lots = lotsFor(notional, p.entryUsd, c);
  const side = p.side === "long" ? "buy" : "sell";
  const stopPx = p.stopUsd || (p.side === "long" ? p.entryUsd * (1 - stopPct) : p.entryUsd * (1 + stopPct));
  const riskPx = Math.abs(p.entryUsd - stopPx);
  const tpPx = pxStr(
    p.side === "long" ? p.entryUsd + riskPx * 1 : p.entryUsd - riskPx * 1,
    c.tickSize,
  );
  const slRaw = p.side === "long"
    ? Math.max(stopPx, p.entryUsd * (1 - ictLiqPct(lev) + 0.002))
    : Math.min(stopPx, p.entryUsd * (1 + ictLiqPct(lev) - 0.002));
  const slPx = pxStr(slRaw, c.tickSize);
  const capPx = pxStr(
    p.side === "long" ? p.entryUsd + riskPx * 0.2 : p.entryUsd - riskPx * 0.2,
    c.tickSize,
  );

  const entryBody: Record<string, unknown> = {
    clientOid: oid("e"),
    symbol: c.symbol,
    side,
    type: "limit",
    price: capPx,
    timeInForce: "IOC",
    leverage: String(lev),
    size: lots,
    marginMode: "ISOLATED",
    reduceOnly: false,
  };

  let fillOid = "";
  try {
    const r = await place(mode, entryBody);
    fillOid = String(r.orderId || "");
  } catch (e) {
    log({ kind: "entry-fail", symbol: p.symbol, err: String(e) });
    push(s, `LIVE entry FAIL ${p.symbol} · ${String(e).slice(0, 80)}`, "down");
    if (mode === "on") releasePaper(s, p, "order rejected");
    return;
  }

  let filled = lots;
  if (mode === "on" && fillOid) {
    let known = false;
    for (let i = 0; i < 2 && !known; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const o = await kucoin<{ dealSize?: number; status?: string }>("GET", `/api/v1/orders/${fillOid}`);
        filled = Math.floor(Number(o?.dealSize || 0) / c.lotSize) * c.lotSize;
        known = true;
        log({ kind: "entry-state", symbol: p.symbol, dealSize: filled, status: o?.status, cap: capPx });
      } catch (e) {
        log({ kind: "entry-state-fail", try: i + 1, err: String(e) });
      }
    }
    if (!known) {
      try {
        const data = await kucoin<{ symbol?: string; currentQty?: string | number }[] | { items?: { symbol?: string; currentQty?: string | number }[] }>("GET", "/api/v1/positions");
        const rows = Array.isArray(data) ? data : data?.items || [];
        const qty = Number(rows.find((r) => r.symbol === c.symbol)?.currentQty || 0);
        if (Math.abs(qty) > 0) {
          filled = lots;
          known = true;
        }
      } catch (e) {
        log({ kind: "entry-pos-fail", err: String(e) });
      }
    }
    if (!known || !(filled > 0)) {
      push(s, `LIVE skip ${p.symbol} · price past ${capPx} · no chase`, "warn");
      releasePaper(s, p, "not filled");
      return;
    }
  }

  const tpLots = Math.floor(filled / c.lotSize) * c.lotSize;
  const tpBody: Record<string, unknown> = {
    clientOid: oid("tp"),
    symbol: c.symbol,
    side: p.side === "long" ? "sell" : "buy",
    type: "limit",
    price: String(tpPx),
    size: tpLots,
    postOnly: true,
    reduceOnly: true,
    marginMode: "ISOLATED",
  };
  const slBody: Record<string, unknown> = {
    clientOid: oid("sl"),
    symbol: c.symbol,
    side: p.side === "long" ? "sell" : "buy",
    type: "market",
    stop: p.side === "long" ? "down" : "up",
    stopPrice: String(slPx),
    stopPriceType: "TP",
    size: filled,
    reduceOnly: true,
    closeOrder: true,
    marginMode: "ISOLATED",
  };

  let slOid = "";
  slOid = await placeStop(mode, slBody);
  if (!slOid) {
    log({ kind: "sl-naked", symbol: p.symbol });
    try {
      await place(mode, {
        clientOid: oid("x"),
        symbol: c.symbol,
        side: p.side === "long" ? "sell" : "buy",
        type: "market",
        size: filled,
        reduceOnly: true,
        closeOrder: true,
        marginMode: "ISOLATED",
      });
    } catch (e) {
      log({ kind: "sl-flatten-fail", symbol: p.symbol, err: String(e) });
    }
    push(s, `LIVE flatten ${p.symbol} · stop did not stick`, "down");
    if (mode === "on") releasePaper(s, p, "flattened, no stop");
    return;
  }
  let tpOid = "";
  if (tpLots >= c.lotSize) {
    try {
      tpOid = String((await place(mode, tpBody)).orderId || "");
    } catch (e) {
      log({ kind: "tp-fail", err: String(e) });
    }
  }

  book.seats.push({
    paperId: p.id,
    symbol: p.symbol,
    inst: c.symbol,
    side: p.side,
    entry: p.entryUsd,
    stop: Number(slPx),
    lots: filled,
    lotsLeft: filled,
    lev,
    entryOid: fillOid,
    tpOid,
    slOid,
    partialed: false,
    openedAt: Date.now(),
  });
  saveBook(book);
  push(
    s,
    `${mode === "on" ? "LIVE" : "LIVE dry"} ${p.side} ${p.symbol} ${filled} lots · cap ${capPx} · 1R $${riskUsd.toFixed(2)} of $${eq.toFixed(0)} · full @ 1R · flat 1h · SL ${slPx}`,
    "up",
  );
}

async function flatten(mode: LiveMode, seat: LiveSeat, why: string) {
  await cancel(mode, seat.tpOid);
  await cancel(mode, seat.slOid);
  if (seat.lotsLeft > 0) {
    try {
      await place(mode, {
        clientOid: oid("x"),
        symbol: seat.inst,
        side: seat.side === "long" ? "sell" : "buy",
        type: "market",
        size: seat.lotsLeft,
        reduceOnly: true,
        closeOrder: true,
        marginMode: "ISOLATED",
      });
    } catch (e) {
      log({ kind: "flatten-fail", symbol: seat.symbol, err: String(e), why });
    }
  }
  log({ kind: "flatten", symbol: seat.symbol, why });
}

/** A position the process does not know about has no stop. Close it. */
async function flattenUnknown(mode: LiveMode, book: LiveBook, s: EngineState) {
  let rows: { symbol?: string; currentQty?: string | number; isOpen?: boolean }[] = [];
  try {
    const data = await kucoin<typeof rows | { items?: typeof rows }>("GET", "/api/v1/positions");
    rows = Array.isArray(data) ? data : data?.items || [];
  } catch (e) {
    log({ kind: "pos-fail", err: String(e) });
    return;
  }
  const known = new Set(book.seats.map((x) => x.inst));
  for (const p of rows) {
    const qty = Number(p.currentQty || 0);
    const inst = String(p.symbol || "");
    if (!inst || !(Math.abs(qty) > 0) || known.has(inst)) continue;
    try {
      await place(mode, {
        clientOid: oid("x"),
        symbol: inst,
        side: qty > 0 ? "sell" : "buy",
        type: "market",
        size: Math.abs(qty),
        reduceOnly: true,
        closeOrder: true,
        marginMode: "ISOLATED",
      });
      log({ kind: "orphan-flat", symbol: inst, qty });
      push(s, `LIVE flatten ${inst} · position had no stop`, "down");
    } catch (e) {
      log({ kind: "orphan-fail", symbol: inst, err: String(e) });
    }
  }
}

/** Call after paper tick. Paper book unchanged. */
export async function syncKucoinLive(s: EngineState) {
  const mode = liveMode();
  const { key, secret, pass } = keys();
  if (mode === "off") return;
  if (mode === "on" && !(key && secret && pass)) {
    log({ kind: "skip", why: "no-keys" });
    return;
  }
  const book = loadBook();
  if (mode === "on") await flattenUnknown(mode, book, s);
  const paperOpen = s.open.filter((p) => p.origin === "ict");
  const queued = [...(s.ictLivePend || []), ...ictLivePend.splice(0)];
  s.ictLivePend = [];
  const seen = new Set(book.seats.map((x) => x.paperId + x.symbol));
  for (const p of [...queued, ...paperOpen]) {
    if (p.origin !== "ict") continue;
    if (!paperOpen.some((o) => o.id === p.id)) {
      if (!seen.has(`skip:${p.id}`)) {
        push(s, `LIVE dry skip ${p.symbol} · closed before the order`, "warn");
        seen.add(`skip:${p.id}`);
      }
      continue;
    }
    if (seen.has(p.id + p.symbol) || book.seats.some((x) => x.paperId === p.id || x.symbol === p.symbol)) continue;
    if (!queued.includes(p) && Date.now() - p.openedAt > 5 * 60_000) continue;
    try {
      await enter(s, p, mode, book);
    } catch (e) {
      log({ kind: "enter-throw", symbol: p.symbol, err: String(e) });
      push(s, `LIVE dry FAIL ${p.symbol} · ${String(e).slice(0, 80)}`, "down");
    }
    seen.add(p.id + p.symbol);
    break;
  }

  for (const seat of [...book.seats]) {
    const paper = paperOpen.find((p) => p.id === seat.paperId || p.symbol === seat.symbol);
    if (!paper) {
      if (Date.now() - seat.openedAt < 25_000) continue;
      await flatten(mode, seat, "paper-closed");
      book.seats = book.seats.filter((x) => x.paperId !== seat.paperId);
      saveBook(book);
      push(s, `LIVE flatten ${seat.symbol} · paper closed`, "mute");
      continue;
    }
    if (paper.partialed && !seat.partialed) {
      seat.partialed = true;
      seat.lotsLeft = Math.max(0, seat.lots - Math.floor(seat.lots * 0.75));
      saveBook(book);
      push(s, `LIVE ¾ assumed filled ${seat.symbol} (resting TP)`, "up");
    }
  }
}
