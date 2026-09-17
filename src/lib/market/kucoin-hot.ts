import { ICT_ASSETS, type IctAssetDef } from "@/lib/engine/universe";

const CORE = new Set(ICT_ASSETS.map((a) => a.symbol.toUpperCase()));
const SKIP = new Set(["USDT", "USDC", "USD", "DAI", "KCS", "XBT", "BTC", "XAUT"]);
const HOT_N = 6;

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
      if (lev < 50 || vol < 8_000_000) continue;
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