/**
 * KuCoin USDT-M isolated live probe. Off unless ICT_LIVE=1 and keys exist.
 * Paper book is untouched. 1 seat. 9% until the bet base is under $64, then 18%.
 * Prime bank: vault only grows. 15% of anything above the working cap is locked once
 * per equity change and is never sized. The other 85% stays as a cushion so one
 * loss does not shrink the next bet. The cap steps up only after that vault is
 * already there. Ceiling $1,000, 1R $180. Jun–Sep 2026 from $130 ended about
 * $13,700 with about $12,500 in the vault. A loss hits working only.
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import type { EngineState, Position, Side } from "./types";
import { ICT_HARD_RISK_PCT } from "./types";
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

/**
 * Working cap steps only after the vault already holds the gate.
 * 1R at the ceiling is 18% of $1,000 = $180. A 1% stop is then about an $18k fill,
 * the same bet as the old steps book, not a $90k order the thin alts will not fill.
 * Lock is 15% of the excess, once per equity change.
 */
const PRIME_GATES: ReadonlyArray<readonly [number, number]> = [
  [0, 200],
  [40, 300],
  [80, 400],
  [150, 600],
  [300, 1000],
];
const PRIME_LOCK = 0.15;

function primeCap(vault: number): number {
  let cap = PRIME_GATES[0][1];
  for (const [need, c] of PRIME_GATES) if (vault + 1e-9 >= need) cap = c;
  return cap;
}

function bookVault(book: LiveBook): number {
  const v = Number(book.vault);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function money2(n: number): number {
  return Math.round(n * 100) / 100;
}

type Prime = { vault: number; working: number; cap: number; locked: number; capWas: number; dirty: boolean; cut: boolean };

/** One lock per equity change. Does not refill the vault. A withdraw (wallet under the vault) cuts the vault to the cash that is actually there. */
function settlePrime(book: LiveBook, wallet: number): Prime {
  const capWas = primeCap(bookVault(book));
  let vault = bookVault(book);
  const prevVault = money2(vault);
  const prevMark = book.markedEquity;
  let cut = false;
  if (wallet + 1 < vault) {
    vault = Math.max(0, wallet);
    cut = true;
  }
  const seen = book.markedEquity;
  const changed = seen == null || !Number.isFinite(Number(seen)) || Math.abs(wallet - Number(seen)) >= 1;
  let cap = primeCap(vault);
  let working = wallet - vault;
  let locked = 0;
  if (changed && working > cap + 0.5) {
    locked = (working - cap) * PRIME_LOCK;
    vault += locked;
    working -= locked;
    cap = primeCap(vault);
  }
  book.vault = money2(vault);
  book.markedEquity = money2(wallet);
  const dirty =
    book.vault !== prevVault ||
    book.markedEquity !== (prevMark == null || !Number.isFinite(Number(prevMark)) ? null : money2(Number(prevMark)));
  return { vault: book.vault, working: wallet - book.vault, cap, locked, capWas, dirty, cut };
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
  /** Limit is on the book. The next tick attaches the stop once it fills. */
  pending?: boolean;
  deadline?: number;
  tp?: number;
};

type LiveBook = {
  seats: LiveSeat[];
  /** Cash that is never sized. Only grows, unless the wallet itself was withdrawn. */
  vault?: number;
  /** Last exchange equity we already settled. Stops the 60% lock from grinding the cushion every tick. */
  markedEquity?: number;
};

function loadBook(): LiveBook {
  if (!existsSync(LIVE_FILE)) return { seats: [] };
  try {
    const b = JSON.parse(readFileSync(LIVE_FILE, "utf8")) as LiveBook;
    if (!Array.isArray(b.seats)) b.seats = [];
    if (!(Number(b.vault) > 0)) b.vault = 0;
    return b;
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

type Contract = { symbol: string; multiplier: number; lotSize: number; tickSize: number; maxLeverage: number; maintainMargin: number };

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
      maintainMargin: Number(r.maintainMargin) > 0 ? Number(r.maintainMargin) : 0.005,
    };
    contractCache.set(symbol, c);
  }
  return contractCache.get(want) || null;
}


/** Real isolated liquidation distance. KuCoin maintenance, not the 0.5% model. */
export function realLiqPct(lev: number, mmr: number): number {
  return Math.max(0.004, 1 / Math.max(2, lev) - Math.max(0, mmr));
}

/** Highest leverage that keeps the wick stop inside that coin's real liquidation. 0 = skip. */
export function levInsideStop(stopPct: number, mmr: number, maxLev: number, pref = 40): number {
  const room = Math.max(0.004, stopPct) + Math.max(0, mmr) + 0.002;
  if (!(room > 0) || room >= 1) return 0;
  const fit = Math.floor(1 / room);
  const lev = Math.min(pref, Math.max(1, Math.floor(maxLev)), fit);
  return lev >= 5 ? lev : 0;
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

/** Skip a limit the exchange would reject: the live mark is already too far through the entry. */
export function orderPastMark(side: Side, entry: number, mark: number, riskPx: number, lev: number): boolean {
  if (!(mark > 0) || !(entry > 0) || !(riskPx > 0)) return false;
  const adverse = side === "long" ? entry - mark : mark - entry;
  if (adverse > riskPx * 0.35) return true;
  const band = (entry * 0.85) / Math.max(2, lev);
  return adverse > 0 && Math.abs(mark - entry) > band;
}

/**
 * Price has already gone 0.05R the right way. Resting the entry after that
 * only fills the pullback, and those pullbacks are what end a small July.
 * A gap already past 0.05R is not a fill.
 */
export function alreadyLeft(side: Side, entry: number, mark: number, riskPx: number): boolean {
  if (!(mark > 0) || !(entry > 0) || !(riskPx > 0)) return false;
  const fav = side === "long" ? (mark - entry) / riskPx : (entry - mark) / riskPx;
  return fav > 0.05;
}
export function positionIsFlat(qty: Map<string, number> | null, inst: string, ageMs: number): boolean {
  if (!qty || ageMs < 8_000) return false;
  if (!qty.has(inst)) return false;
  return Math.abs(qty.get(inst) || 0) === 0;
}

/** A working target or stop is doing the job. Do not cancel it and sell the pullback. A time exit still flattens. qty 0 means the position is confirmed flat. */
export function keepWorkingExit(reason: string | undefined, tpOpen: boolean, slOpen: boolean, qty: number): boolean {
  if (reason === "time") return false;
  if (!(tpOpen || slOpen)) return false;
  if (qty === 0) return false;
  return true;
}
export function ictBracket(side: Side, tpPx: string, slPx: string, size: number) {
  const exitSide = side === "long" ? "sell" : "buy";
  const sl = {
    side: exitSide,
    type: "market" as const,
    stopPriceType: "TP",
    size,
    reduceOnly: true,
    marginMode: "ISOLATED",
    stop: side === "long" ? "down" : "up",
    stopPrice: slPx,
  };
  // Resting limit. A wick through 1.25R fills here. A stop-market sells the pullback.
  const tp = {
    side: exitSide,
    type: "limit" as const,
    price: tpPx,
    size,
    reduceOnly: true,
    marginMode: "ISOLATED",
    timeInForce: "GTC",
    postOnly: true,
  };
  const tpStop = {
    side: exitSide,
    type: "market" as const,
    stopPriceType: "TP",
    size,
    reduceOnly: true,
    marginMode: "ISOLATED",
    stop: side === "long" ? "up" : "down",
    stopPrice: tpPx,
  };
  return { sl, tp, tpStop };
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
  return Number(d?.accountEquity || d?.availableBalance || 0);
}

async function markPrice(symbol: string): Promise<number> {
  try {
    const res = await fetch(`${BASE}/api/v1/ticker?symbol=${encodeURIComponent(symbol)}`, {
      headers: { Accept: "application/json", "User-Agent": "NightshiftDesk/live" },
      signal: AbortSignal.timeout(2_000),
    });
    const json = (await res.json()) as { data?: { price?: string } };
    const px = Number(json?.data?.price || 0);
    return px > 0 ? px : 0;
  } catch {
    return 0;
  }
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

/** Limit at the target. If the exchange rejects it, the old stop-market is the backup. */
async function placeTp(mode: LiveMode, symbol: string, bracket: ReturnType<typeof ictBracket>, tpLots: number): Promise<string> {
  try {
    const id = String((await place(mode, { clientOid: oid("tp"), symbol, ...bracket.tp, size: tpLots })).orderId || "");
    if (id) return id;
  } catch (e) {
    log({ kind: "tp-limit-fail", err: String(e) });
  }
  try {
    return String((await place(mode, { clientOid: oid("tp"), symbol, ...bracket.tpStop, size: tpLots })).orderId || "");
  } catch (e) {
    log({ kind: "tp-fail", err: String(e) });
    return "";
  }
}

async function orderIsOpen(mode: LiveMode, id?: string): Promise<boolean> {
  if (mode !== "on" || !id || id.startsWith("dry-")) return false;
  try {
    const o = await kucoin<{ status?: string }>("GET", `/api/v1/orders/${id}`);
    return o?.status === "open";
  } catch (e) {
    log({ kind: "order-state-fail", id, err: String(e) });
    return false;
  }
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

/** A leftover entry from a restart has no stop behind it. A pending seat is still that order, so it stays. */
async function cancelStrayEntries(mode: LiveMode, keep: Set<string>) {
  if (mode !== "on") return;
  try {
    const data = await kucoin<{ items?: { id?: string; clientOid?: string; reduceOnly?: boolean }[] } | { id?: string; clientOid?: string; reduceOnly?: boolean }[]>(
      "GET",
      "/api/v1/orders?status=active",
    );
    const rows = Array.isArray(data) ? data : data?.items || [];
    for (const o of rows) {
      const id = String(o.id || "");
      if (!id || o.reduceOnly || keep.has(id)) continue;
      if (!String(o.clientOid || "").startsWith("e-")) continue;
      await cancel(mode, id);
      log({ kind: "stray-entry-cancel", id });
    }
  } catch (e) {
    log({ kind: "stray-entry-fail", err: String(e) });
  }
}

async function absPosQty(inst: string): Promise<number> {
  try {
    const data = await kucoin<{ symbol?: string; currentQty?: string | number }[] | { items?: { symbol?: string; currentQty?: string | number }[] }>("GET", "/api/v1/positions");
    const rows = Array.isArray(data) ? data : data?.items || [];
    return Math.abs(Number(rows.find((r) => r.symbol === inst)?.currentQty || 0));
  } catch (e) {
    log({ kind: "entry-pos-fail", err: String(e) });
    return 0;
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
  const markP = mode === "on" ? markPrice(instOf(p.symbol)) : Promise.resolve(0);
  const c = await contractFor(p.symbol);
  if (!c) {
    log({ kind: "skip", why: "no-contract", symbol: p.symbol });
    push(s, `LIVE dry skip ${p.symbol} · no ${instOf(p.symbol)} contract`, "warn");
    if (mode === "on") releasePaper(s, p, "no contract");
    return;
  }
  let eq = liveUsd();
  let vaultUsd = 0;
  let workingUsd = eq;
  let capUsd = 200;
  if (mode === "on") {
    try {
      const wallet = await usdtEquity();
      if (!(wallet > 0)) throw new Error("wallet 0");
      const prime = settlePrime(book, wallet);
      saveBook(book);
      vaultUsd = prime.vault;
      workingUsd = prime.working;
      capUsd = prime.cap;
      eq = Math.min(Math.max(0, prime.working), prime.cap);
    } catch (e) {
      log({ kind: "equity-fail", err: String(e) });
      push(s, `LIVE equity fail · ${String(e).slice(0, 80)}`, "down");
      releasePaper(s, p, "equity fail");
      return;
    }
  }
  const riskPct = eq < 64 ? 0.09 : ICT_HARD_RISK_PCT;
  const riskUsd = eq * riskPct;
  const stopPct = Math.max(1e-6, p.stopPct || Math.abs(p.entryUsd - (p.stopUsd || p.entryUsd)) / p.entryUsd);
  if (eq < 20 || riskUsd < 2) {
    log({ kind: "skip", why: "no-funds", eq, riskUsd, vault: vaultUsd, working: workingUsd });
    if (vaultUsd >= 1) {
      push(
        s,
        `prime bank · vault $${vaultUsd.toFixed(0)} stays · working $${workingUsd.toFixed(0)} · too small to trade`,
        "warn",
      );
    } else {
      push(s, `LIVE skip ${p.symbol} · wallet $${eq.toFixed(2)} (need ≥$20 on futures)`, "warn");
    }
    if (mode === "on") releasePaper(s, p, "wallet");
    return;
  }
  if (mode === "on") {
    push(
      s,
      `prime bank · vault $${vaultUsd.toFixed(0)} · working $${workingUsd.toFixed(0)} · cap $${capUsd} · 1R $${riskUsd.toFixed(0)}`,
      "up",
    );
  }
  const asked = Math.min(40, Math.max(1, Number(String(p.note.match(/(\d+)x/)?.[1] || 40))));
  const mmr = c.maintainMargin > 0 ? c.maintainMargin : 0.005;
  const lev = levInsideStop(stopPct, mmr, Math.min(asked, c.maxLeverage || asked), asked);
  if (!lev) {
    log({ kind: "skip", why: "liq-past-stop", symbol: p.symbol, stopPct, mmr });
    push(s, `LIVE skip ${p.symbol} · stop is past the real liquidation`, "warn");
    if (mode === "on") releasePaper(s, p, "stop past liquidation");
    return;
  }
  const notional = Math.min(riskUsd / stopPct, eq * lev * 0.85);
  const lots = lotsFor(notional, p.entryUsd, c);
  const side = p.side === "long" ? "buy" : "sell";
  const stopPx = p.stopUsd || (p.side === "long" ? p.entryUsd * (1 - stopPct) : p.entryUsd * (1 + stopPct));
  const riskPx = Math.abs(p.entryUsd - stopPx);
  const tgtR = p.targetR > 1 ? p.targetR : 1;
  const tpPx = pxStr(
    p.side === "long" ? p.entryUsd + riskPx * tgtR : p.entryUsd - riskPx * tgtR,
    c.tickSize,
  );
  const liqPct = realLiqPct(lev, mmr);
  const slRaw = p.side === "long"
    ? Math.max(stopPx, p.entryUsd * (1 - liqPct + 0.002))
    : Math.min(stopPx, p.entryUsd * (1 + liqPct - 0.002));
  const slPx = pxStr(slRaw, c.tickSize);
  const capPx = pxStr(p.entryUsd, c.tickSize);
  if (mode === "on") {
    const mark = await markP;
    if (orderPastMark(p.side, p.entryUsd, mark, riskPx, lev)) {
      log({ kind: "skip", why: "past-mark", symbol: p.symbol, mark, entry: p.entryUsd, cap: capPx });
      push(s, `LIVE skip ${p.symbol} · live ${mark} is past the entry · no chase`, "warn");
      releasePaper(s, p, "past the live price");
      return;
    }
    if (alreadyLeft(p.side, p.entryUsd, mark, riskPx)) {
      log({ kind: "skip", why: "already-left", symbol: p.symbol, mark, entry: p.entryUsd });
      push(s, `LIVE skip ${p.symbol} · live ${mark} is already 0.05R through · a pullback is not the fill`, "warn");
      releasePaper(s, p, "already left");
      return;
    }
  }

  const entryBody: Record<string, unknown> = {
    clientOid: oid("e"),
    symbol: c.symbol,
    side,
    type: "limit",
    price: capPx,
    timeInForce: "GTC",
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
    const tfMs = p.note.includes("15m") ? 15 * 60_000 : 5 * 60_000;
    const nextClose = (p.openedAt || Date.now()) + 2 * tfMs;
    const deadline = Math.min(nextClose, Date.now() + tfMs);
    const seat: LiveSeat = {
      paperId: p.id,
      symbol: p.symbol,
      inst: c.symbol,
      side: p.side,
      entry: p.entryUsd,
      stop: Number(slPx),
      tp: Number(tpPx),
      lots,
      lotsLeft: 0,
      lev,
      entryOid: fillOid,
      tpOid: "",
      slOid: "",
      partialed: false,
      openedAt: Date.now(),
      pending: true,
      deadline,
    };
    book.seats.push(seat);
    saveBook(book);
    push(s, `resting ${p.symbol} through this bar · limit stays at the entry · no chase`, "mute");
    await armPending(s, mode, book, seat);
    return;
  }

  const tpLots = Math.floor(filled / c.lotSize) * c.lotSize;
  const bracket = ictBracket(p.side, String(tpPx), String(slPx), filled);
  const slBody: Record<string, unknown> = {
    clientOid: oid("sl"),
    symbol: c.symbol,
    ...bracket.sl,
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
  if (tpLots >= c.lotSize) tpOid = await placeTp(mode, c.symbol, bracket, tpLots);

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
    `${mode === "on" ? "LIVE" : "LIVE dry"} ${p.side} ${p.symbol} ${filled} lots · entry ${capPx} · 1R $${riskUsd.toFixed(2)} of $${eq.toFixed(0)} · ${lev}x · full @ ${tgtR}R limit ${tpPx} · SL ${slPx}`,
    "up",
  );
}

function touchLock() {
  const state = process.env.ICT_STATE_PATH || "ict-state.json";
  const lock = `${state}.lock`;
  try {
    if (existsSync(lock)) writeFileSync(lock, String(Date.now()));
  } catch {
    /* the worker owns the lock */
  }
}

/** One look at a resting limit. A fill gets its stop. The bar ending cancels it. Otherwise return so the next close can scan. */
async function armPending(s: EngineState, mode: LiveMode, book: LiveBook, seat: LiveSeat) {
  if (!seat.pending || !seat.entryOid) return;
  const c = await contractFor(seat.symbol);
  if (!c) return;
  const paper = s.open.find((p) => p.id === seat.paperId || (p.origin === "ict" && p.symbol === seat.symbol));
  let filled = 0;
  let done = false;
  const started = Date.now();
  let expired = Date.now() >= (seat.deadline || 0);
  while (!expired) {
    touchLock();
    done = false;
    try {
      const o = await kucoin<{ dealSize?: number; status?: string }>("GET", `/api/v1/orders/${seat.entryOid}`);
      filled = Math.floor(Number(o?.dealSize || 0) / c.lotSize) * c.lotSize;
      done = o?.status === "done";
      log({ kind: "entry-state", symbol: seat.symbol, dealSize: filled, status: o?.status });
    } catch (e) {
      log({ kind: "entry-state-fail", err: String(e) });
    }
    if (!(filled > 0)) {
      const qty = await absPosQty(c.symbol);
      if (qty > 0) filled = Math.floor(qty / c.lotSize) * c.lotSize;
    }
    if (filled > 0 || done) break;
    const untilClose = 5 * 60 * 1000 - (Date.now() % (5 * 60 * 1000));
    if (Date.now() - started > 8_000 || untilClose < 12_000) return;
    await new Promise((r) => setTimeout(r, 1000));
    expired = Date.now() >= (seat.deadline || 0);
  }
  if (!(filled > 0) && !expired && !done) return;
  if (!(filled > 0)) {
    await cancel(mode, seat.entryOid);
    const qty = await absPosQty(c.symbol);
    if (qty > 0) filled = Math.floor(qty / c.lotSize) * c.lotSize;
  }
  if (!(filled > 0)) {
    book.seats = book.seats.filter((x) => x.paperId !== seat.paperId);
    saveBook(book);
    if (paper) releasePaper(s, paper, "not filled");
    else push(s, `LIVE skip ${seat.symbol} · this bar never traded the entry · no chase`, "warn");
    return;
  }
  if (filled < seat.lots) await cancel(mode, seat.entryOid);
  const tpPx = pxStr(seat.tp || seat.entry, c.tickSize);
  const slPx = pxStr(seat.stop, c.tickSize);
  const tpLots = Math.floor(filled / c.lotSize) * c.lotSize;
  const bracket = ictBracket(seat.side, tpPx, slPx, filled);
  const slOid = await placeStop(mode, { clientOid: oid("sl"), symbol: c.symbol, ...bracket.sl });
  if (!slOid) {
    log({ kind: "sl-naked", symbol: seat.symbol });
    try {
      await place(mode, {
        clientOid: oid("x"),
        symbol: c.symbol,
        side: seat.side === "long" ? "sell" : "buy",
        type: "market",
        size: filled,
        reduceOnly: true,
        closeOrder: true,
        marginMode: "ISOLATED",
      });
    } catch (e) {
      log({ kind: "sl-flatten-fail", symbol: seat.symbol, err: String(e) });
    }
    book.seats = book.seats.filter((x) => x.paperId !== seat.paperId);
    saveBook(book);
    push(s, `LIVE flatten ${seat.symbol} · stop did not stick`, "down");
    if (paper) releasePaper(s, paper, "flattened, no stop");
    return;
  }
  let tpOid = "";
  if (tpLots >= c.lotSize) tpOid = await placeTp(mode, c.symbol, bracket, tpLots);
  seat.pending = false;
  seat.lots = filled;
  seat.lotsLeft = filled;
  seat.slOid = slOid;
  seat.tpOid = tpOid;
  seat.stop = Number(slPx);
  saveBook(book);
  push(
    s,
    `LIVE ${seat.side} ${seat.symbol} ${filled} lots · filled ${pxStr(seat.entry, c.tickSize)} · full @ limit ${tpPx} · SL ${slPx}`,
    "up",
  );
}

/** Open contracts by symbol. Null means the read failed, so stops stay up. */
async function positionQty(mode: LiveMode): Promise<Map<string, number> | null> {
  if (mode !== "on") return new Map();
  try {
    const data = await kucoin<{ symbol?: string; currentQty?: string | number }[] | { items?: { symbol?: string; currentQty?: string | number }[] }>("GET", "/api/v1/positions");
    const rows = Array.isArray(data) ? data : data?.items || [];
    const out = new Map<string, number>();
    for (const r of rows) out.set(String(r.symbol || ""), Number(r.currentQty || 0));
    return out;
  } catch (e) {
    log({ kind: "pos-qty-fail", err: String(e) });
    return null;
  }
}

async function flatten(mode: LiveMode, seat: LiveSeat, why: string) {
  let qty: number | null = null;
  if (mode === "on") {
    try {
      const data = await kucoin<{ symbol?: string; currentQty?: string | number }[] | { items?: { symbol?: string; currentQty?: string | number }[] }>("GET", "/api/v1/positions");
      const rows = Array.isArray(data) ? data : data?.items || [];
      const row = rows.find((r) => r.symbol === seat.inst);
      qty = row ? Math.abs(Number(row.currentQty || 0)) : 0;
    } catch (e) {
      log({ kind: "flatten-qty-fail", err: String(e) });
    }
  }
  if (qty === 0) {
    await cancel(mode, seat.tpOid);
    await cancel(mode, seat.slOid);
    log({ kind: "flatten", symbol: seat.symbol, why, already: "flat" });
    return;
  }
  await cancel(mode, seat.tpOid);
  await cancel(mode, seat.slOid);
  const size = qty && qty > 0 ? qty : seat.lotsLeft;
  if (size > 0) {
    try {
      await place(mode, {
        clientOid: oid("x"),
        symbol: seat.inst,
        side: seat.side === "long" ? "sell" : "buy",
        type: "market",
        size,
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

/** Open contracts or a filled seat: equity includes the trade. Don't bank that. */
function accountIsFlat(book: LiveBook, qty: Map<string, number> | null): boolean {
  if (!qty) return false;
  for (const q of qty.values()) if (Math.abs(q) > 0) return false;
  return !book.seats.some((seat) => !seat.pending);
}
/** A limit whose bar has ended is cleared before the next scan, so the new close is not skipped. */
export async function expireDue(s: EngineState): Promise<void> {
  if (liveMode() !== "on") return;
  const book = loadBook();
  for (const seat of [...book.seats]) {
    if (!seat.pending || Date.now() < (seat.deadline || 0)) continue;
    await armPending(s, liveMode(), book, seat);
  }
}

export async function syncKucoinLive(s: EngineState) {
  const mode = liveMode();
  const { key, secret, pass } = keys();
  if (mode === "off") return;
  if (mode === "on" && !(key && secret && pass)) {
    log({ kind: "skip", why: "no-keys" });
    return;
  }
  const book = loadBook();
  const paperOpen = s.open.filter((p) => p.origin === "ict");
  const queued = [...(s.ictLivePend || []), ...ictLivePend.splice(0)];
  s.ictLivePend = [];
  const rush = mode === "on" && book.seats.length === 0 && queued.length > 0;
  if (mode === "on" && !rush) {
    const keep = new Set(book.seats.map((x) => x.entryOid).filter((id): id is string => Boolean(id)));
    await cancelStrayEntries(mode, keep);
    await flattenUnknown(mode, book, s);
    for (const seat of [...book.seats]) {
      if (seat.pending) await armPending(s, mode, book, seat);
    }
  }
  const qty = rush ? null : await positionQty(mode);
  if (mode === "on" && !rush && accountIsFlat(book, qty)) {
    try {
      const wallet = await usdtEquity();
      if (wallet > 0) {
        const p = settlePrime(book, wallet);
        if (p.dirty) saveBook(book);
        if (p.cut) {
          push(
            s,
            `prime bank · wallet is under the vault · vault now $${p.vault.toFixed(0)} · working $${p.working.toFixed(0)}`,
            "warn",
          );
        } else if (p.locked >= 1 || p.cap > p.capWas + 1) {
          const tier = p.cap > p.capWas + 1 ? ` · tier cap $${p.cap}` : "";
          push(
            s,
            `prime bank · locked $${p.locked.toFixed(0)}${tier} · vault $${p.vault.toFixed(0)} · working $${p.working.toFixed(0)} · not for the next loss`,
            "up",
          );
        }
      }
    } catch (e) {
      log({ kind: "prime-fail", err: String(e) });
    }
  }
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
    const tfMs = p.note.includes("15m") ? 15 * 60_000 : 5 * 60_000;
    const born = p.liveAt || p.openedAt;
    const limit = p.liveAt ? tfMs : 2 * tfMs;
    if (!queued.includes(p) && Date.now() - born > limit) continue;
    const seats = book.seats.length;
    try {
      await enter(s, p, mode, book);
    } catch (e) {
      log({ kind: "enter-throw", symbol: p.symbol, err: String(e) });
      push(s, `LIVE dry FAIL ${p.symbol} · ${String(e).slice(0, 80)}`, "down");
    }
    seen.add(p.id + p.symbol);
    if (book.seats.length > seats) break;
  }
  if (rush && mode === "on") {
    const keep = new Set(book.seats.map((x) => x.entryOid).filter((id): id is string => Boolean(id)));
    await cancelStrayEntries(mode, keep);
  }

  for (const seat of [...book.seats]) {
    if (seat.pending) continue;
    if (positionIsFlat(qty, seat.inst, Date.now() - seat.openedAt)) {
      await cancel(mode, seat.tpOid);
      await cancel(mode, seat.slOid);
      book.seats = book.seats.filter((x) => x.paperId !== seat.paperId);
      saveBook(book);
      push(s, `LIVE ${seat.symbol} flat · canceled the other order`, "up");
      continue;
    }
    const paper = paperOpen.find((p) => p.id === seat.paperId || p.symbol === seat.symbol);
    if (!paper) {
      if (Date.now() - seat.openedAt < 25_000) continue;
      const done = s.closed.find((c) => c.origin === "ict" && (c.id === seat.paperId || c.symbol === seat.symbol));
      const qtyNow = qty == null ? -1 : Math.abs(qty.get(seat.inst) || 0);
      const tpOpen = await orderIsOpen(mode, seat.tpOid);
      const slOpen = await orderIsOpen(mode, seat.slOid);
      if (keepWorkingExit(done?.reason, tpOpen, slOpen, qtyNow)) {
        const note = `limit still ${seat.symbol}`;
        const last = s.tape.find((ev) => ev.text?.includes(note));
        if (!last || Date.now() - last.t > 5 * 60_000) {
          push(s, `LIVE ${note} · target or stop is working · not selling the pullback`, "mute");
        }
        continue;
      }
      await cancel(mode, seat.entryOid);
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
    const be = paper.entryUsd;
    const paperAtEntry = paper.side === "long"
      ? (paper.stopUsd ?? 0) >= be * (1 - 0.0015)
      : (paper.stopUsd ?? 0) > 0 && (paper.stopUsd ?? 0) <= be * (1 + 0.0015);
    const liveAtEntry = paper.side === "long" ? seat.stop >= be * (1 - 0.0015) : seat.stop > 0 && seat.stop <= be * (1 + 0.0015);
    if (paperAtEntry && !liveAtEntry && seat.lotsLeft > 0) {
      const c = await contractFor(seat.symbol);
      if (c) {
        const oldOid = seat.slOid;
        const oldStop = seat.stop;
        await cancel(mode, oldOid);
        const slPx = pxStr(be, c.tickSize);
        const slBody: Record<string, unknown> = {
          clientOid: oid("sl"),
          symbol: seat.inst,
          ...ictBracket(seat.side, slPx, slPx, seat.lotsLeft).sl,
        };
        let id = await placeStop(mode, slBody);
        if (!id) {
          const back = pxStr(oldStop, c.tickSize);
          id = await placeStop(mode, {
            clientOid: oid("sl"),
            symbol: seat.inst,
            ...ictBracket(seat.side, back, back, seat.lotsLeft).sl,
          });
          if (id) {
            seat.slOid = id;
            saveBook(book);
          }
          push(s, `LIVE stop stay ${seat.symbol} · entry stop did not stick`, "warn");
        } else {
          seat.slOid = id;
          seat.stop = Number(slPx);
          saveBook(book);
          push(s, `LIVE stop to entry ${seat.symbol} · 0.5R tagged · 1.25R still on`, "up");
        }
      }
    }
  }
}
