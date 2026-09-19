import { ICT_ASSETS, type IctAssetDef, type IctBook } from "@/lib/engine/universe";
import type { Candle } from "@/lib/engine/types";

const CORE = new Set(ICT_ASSETS.map((a) => a.symbol.toUpperCase()));
const SKIP = new Set([
  "USDT", "USDC", "USD", "DAI", "KCS", "XBT", "BTC", "XAUT", "PAXG", "XAG",
  "SOXL", "SKHYNIX", "SNDK", "SPCX",
]);
const HOT_N = 10;

/** One shot: last trade on every USDT-M contract. Phone-safe (futures CORS). */
export async function fetchKucoinAllLast(): Promise<Record<string, number>> {
  try {
    const res = await fetch("https://api-futures.kucoin.com/api/v1/allTickers", {
      headers: { Accept: "application/json", "User-Agent": "NightshiftDesk/hot" },
    });
    if (!res.ok) return {};
    const d = (await res.json()) as { data?: { symbol?: string; price?: string }[] };
    const out: Record<string, number> = {};
    for (const t of d.data ?? []) {
      const sym = String(t.symbol ?? "");
      if (!sym.endsWith("USDTM")) continue;
      const base = sym.slice(0, -5);
      const px = Number(t.price);
      if (base && px > 0) out[base] = px;
    }
    return out;
  } catch {
    return {};
  }
}

/** Walk the last 5m/15m bar forward so the chart isn't frozen on a 1h-old close. */
export function applyLiveLast(b: IctBook, last: number, now = Date.now()) {
  if (!(last > 0)) return;
  b.last = last;
  const paint = (bars: Candle[] | undefined, ms: number) => {
    if (!bars?.length) return;
    const bucket = Math.floor(now / ms) * ms;
    const z = bars[bars.length - 1]!;
    if (z.t === bucket) {
      z.c = last;
      z.h = Math.max(z.h, last);
      z.l = Math.min(z.l, last);
    } else if (bucket > z.t) {
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
