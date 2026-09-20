import { ICT_ASSETS, type IctAssetDef, type IctBook } from "@/lib/engine/universe";
import type { Candle } from "@/lib/engine/types";
import { CLOUD_LAST_URL } from "@/lib/cloud-live";

const CORE = new Set(ICT_ASSETS.map((a) => a.symbol.toUpperCase()));
const SKIP = new Set([
  "USDT", "USDC", "USD", "DAI", "KCS", "XBT", "BTC", "XAUT", "PAXG", "XAG",
  "SOXL", "SKHYNIX", "SNDK", "SPCX",
]);
const HOT_N = 10;

let browserLastCache: { t: number; px: Record<string, number> } = { t: 0, px: {} };

/** Browser (GitHub Pages) cannot read KuCoin REST — no ACAO. OKX + Kraken send CORS. */
async function fetchBrowserLast(): Promise<Record<string, number>> {
  if (Date.now() - browserLastCache.t < 2000 && Object.keys(browserLastCache.px).length > 5) {
    return browserLastCache.px;
  }
  const out: Record<string, number> = {};
  try {
    const res = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SWAP", {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const d = (await res.json()) as { data?: { instId?: string; last?: string }[] };
      for (const t of d.data ?? []) {
        const id = String(t.instId ?? "");
        if (!id.endsWith("-USDT-SWAP")) continue;
        const base = id.slice(0, -"-USDT-SWAP".length);
        const px = Number(t.last);
        if (base && px > 0) out[base] = px;
      }
    }
  } catch {
    /* okx optional */
  }
  try {
    const res = await fetch("https://api.kraken.com/0/public/Ticker?pair=XMRUSD,DASHUSD,SOLUSD,XBTUSD", {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const d = (await res.json()) as { result?: Record<string, { c?: string[] }> };
      const alias: Record<string, string> = {
        XMRUSD: "XMR",
        XXMRZUSD: "XMR",
        DASHUSD: "DASH",
        SOLUSD: "SOL",
        XBTUSD: "BTC",
        XXBTZUSD: "BTC",
      };
      for (const [k, v] of Object.entries(d.result ?? {})) {
        const id = alias[k] ?? "";
        const px = Number(v.c?.[0]);
        if (id && px > 0) out[id] = px;
      }
    }
  } catch {
    /* kraken optional */
  }
  if (Object.keys(out).length > 5) browserLastCache = { t: Date.now(), px: out };
  return out;
}

async function fetchCloudKucoinLast(): Promise<{ t: number; px: Record<string, number> } | null> {
  try {
    const res = await fetch(`${CLOUD_LAST_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { t?: number; px?: Record<string, number> };
    if (!j?.t || !j.px) return null;
    return { t: j.t, px: j.px };
  } catch {
    return null;
  }
}

function mapFutBase(sym: string): string {
  const base = sym.endsWith("USDTM") ? sym.slice(0, -5) : "";
  if (base === "XBT") return "BTC";
  return base;
}

/** Phone: live OKX/Kraken for the chart. KuCoin CLOUD wins on thin names (ONE-class) and when fresh. */
export async function fetchKucoinAllLast(): Promise<Record<string, number>> {
  if (typeof window !== "undefined") {
    const [cloud, ox] = await Promise.all([fetchCloudKucoinLast(), fetchBrowserLast()]);
    const out: Record<string, number> = { ...(ox || {}) };
    if (cloud?.px) {
      const age = Date.now() - cloud.t;
      const gate = age < 3 * 60_000 ? 0.003 : 0.02;
      for (const [id, px] of Object.entries(cloud.px)) {
        if (!(px > 0)) continue;
        const alt = out[id];
        if (alt > 0 && Math.abs(alt / px - 1) < gate) continue;
        out[id] = px;
      }
    }
    if (Object.keys(out).length > 5) return out;
  }
  try {
    const res = await fetch("https://api-futures.kucoin.com/api/v1/allTickers", {
      headers: { Accept: "application/json", "User-Agent": "NightshiftDesk/hot" },
    });
    if (!res.ok) return {};
    const d = (await res.json()) as { data?: { symbol?: string; price?: string }[] };
    const out: Record<string, number> = {};
    for (const t of d.data ?? []) {
      const base = mapFutBase(String(t.symbol ?? ""));
      const px = Number(t.price);
      if (base && px > 0) out[base] = px;
    }
    return out;
  } catch {
    return {};
  }
}

export async function fetchKucoinLast(id: string): Promise<number> {
  const all = await fetchKucoinAllLast();
  if (all[id]! > 0) return all[id]!;
  if (typeof window !== "undefined") {
    try {
      const res = await fetch(
        `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(`${id}-USDT-SWAP`)}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.ok) {
        const d = (await res.json()) as { data?: { last?: string }[] };
        const px = Number(d.data?.[0]?.last);
        if (px > 0) return px;
      }
    } catch {
      /* */
    }
  }
  try {
    const res = await fetch(
      `https://api-futures.kucoin.com/api/v1/ticker?symbol=${encodeURIComponent(`${id}USDTM`)}`,
      { headers: { Accept: "application/json" } },
    );
    if (res.ok) {
      const d = (await res.json()) as { data?: { price?: string } };
      const px = Number(d.data?.price);
      if (px > 0) return px;
    }
  } catch {
    /* */
  }
  return 0;
}

/** Walk the last 5m/15m bar forward so the chart isn't frozen on a 1h-old close.
 *  Never invent a sweep: a stale LAST 6% off the body (ONE @ 0.00333 vs 0.00370) used to
 *  pull the wick and become a ghost fill. */
export function applyLiveLast(b: IctBook, last: number, now = Date.now()) {
  if (!(last > 0)) return;
  b.last = last;
  const paint = (bars: Candle[] | undefined, ms: number) => {
    if (!bars?.length) return;
    const bucket = Math.floor(now / ms) * ms;
    const z = bars[bars.length - 1]!;
    const away = Math.abs(last / Math.max(1e-12, z.c) - 1);
    if (z.t === bucket) {
      if (away > 0.015) {
        z.c = Math.min(z.h, Math.max(z.l, last));
        return;
      }
      z.c = last;
      z.h = Math.max(z.h, last);
      z.l = Math.min(z.l, last);
    } else if (bucket > z.t) {
      if (away > 0.02) return;
      bars.push({ t: bucket, o: z.c, h: Math.max(z.c, last), l: Math.min(z.c, last), c: last, v: 0 });
      if (bars.length > 200) bars.splice(0, bars.length - 200);
    }
  };
  paint(b.candles5, 5 * 60_000);
  paint(b.candles15, 15 * 60_000);
  paint(b.candles1h, 60 * 60_000);
}

/** KuCoin USDT-M names that are actually hot: 50×+ and real volume. Not spot lottery ticks. */
export async function fetchKucoinHotAssets(): Promise<IctAssetDef[]> {
  try {
    const res = await fetch("https://api-futures.kucoin.com/api/v1/contracts/active", {
      headers: { Accept: "application/json", "User-Agent": "NightshiftDesk/hot" },
    });
    if (!res.ok) return [];
    const d = (await res.json()) as { data?: Record<string, unknown>[] };
    const rows = d.data ?? [];
    const scored: { vol: number; a: IctAssetDef }[] = [];
    for (const r of rows) {
      if (r.status !== "Open" || r.quoteCurrency !== "USDT") continue;
      const base = String(r.baseCurrency ?? "").toUpperCase();
      if (!base || CORE.has(base) || SKIP.has(base)) continue;
      const im = Number(r.initialMargin) || 1;
      const lev = im > 0 ? 1 / im : 0;
      const vol = Number(r.turnoverOf24h) || 0;
      if (lev < 20 || vol < 4_000_000) continue;
      scored.push({
        vol,
        a: { id: base, symbol: base, name: base, venue: "kucoin", instId: `${base}-USDT` },
      });
    }
    scored.sort((x, y) => y.vol - x.vol);
    const seen = new Set<string>();
    const out: IctAssetDef[] = [];
    for (const s of scored) {
      if (seen.has(s.a.id)) continue;
      seen.add(s.a.id);
      out.push(s.a);
      if (out.length >= HOT_N) break;
    }
    return out;
  } catch {
    return [];
  }
}
