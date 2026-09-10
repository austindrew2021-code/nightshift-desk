import { createServerFn } from "@tanstack/react-start";
import type { Candle, Launch, MarketSnapshot } from "@/lib/engine/types";
import { parseKlines } from "@/lib/engine/ict";
import { estimateUniqueBuyers } from "@/lib/engine/pipeline";
import fallback from "./fallback-klines.json";

type KlinePack = { m15: number[][]; h1: number[][]; m5: number[][] };

const FALLBACK = fallback as KlinePack;

async function getJson(url: string, timeout = 2800): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "NightshiftDesk/1.0" },
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown, d = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

function asOkxRows(data: unknown): string[][] {
  if (!data || typeof data !== "object") return [];
  const rows = (data as { data?: unknown }).data;
  if (!Array.isArray(rows)) return [];
  return rows as string[][];
}

function candlesFromOkx(data: unknown): Candle[] {
  const rows = asOkxRows(data)
    .slice()
    .reverse()
    .map((r) => [num(r[0]), num(r[1]), num(r[2]), num(r[3]), num(r[4]), num(r[5])]);
  return parseKlines(rows);
}

function mapPump(raw: unknown): Launch[] {
  if (!Array.isArray(raw)) return [];
  const out: Launch[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const c = row as Record<string, unknown>;
    if (c.nsfw || c.is_banned) continue;
    const created = num(c.created_timestamp);
    const usdMcap = num(c.usd_market_cap ?? c.market_cap_usd ?? c.market_cap);
    const realSol = num(c.real_sol_reserves) / 1e9;
    const virtualSol = num(c.virtual_sol_reserves) / 1e9;
    const replies = num(c.reply_count);
    const lastTrade = num(c.last_trade_timestamp);
    const holders = num(c.holder_count ?? c.unique_holders ?? c.uniqueHolders);
    out.push({
      mint: String(c.mint ?? ""),
      name: String(c.name ?? "unknown").slice(0, 48),
      symbol: String(c.symbol ?? "?").slice(0, 14),
      description: String(c.description ?? "").slice(0, 180),
      twitter: Boolean(c.twitter),
      website: Boolean(c.website),
      telegram: Boolean(c.telegram),
      usdMcap,
      createdAt: created > 1e12 ? created : created * 1000,
      complete: Boolean(c.complete),
      replies,
      image: typeof c.image_uri === "string" ? c.image_uri : undefined,
      creator: typeof c.creator === "string" ? c.creator : undefined,
      realSol,
      virtualSol,
      uniqueBuyers: holders > 0 ? holders : estimateUniqueBuyers(realSol, replies, usdMcap),
      lastTradeAt: lastTrade > 1e12 ? lastTrade : lastTrade * 1000,
    });
  }
  return out.filter((l) => l.mint && l.symbol);
}

function mergeLaunches(...lists: Launch[][]): Launch[] {
  const map = new Map<string, Launch>();
  for (const list of lists) {
    for (const l of list) {
      const prev = map.get(l.mint);
      if (!prev || l.usdMcap >= prev.usdMcap) map.set(l.mint, l);
    }
  }
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export const getDeskSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<MarketSnapshot> => {
    const sources: string[] = [];
    const empty: MarketSnapshot = {
      fetchedAt: Date.now(),
      solUsd: 99.8,
      solChange24h: -0.034,
      btcUsd: 77200,
      btcChange24h: -0.016,
      fundingSol: 0,
      oiSolUsd: 0,
      longShortSol: 2,
      fearGreed: 50,
      fearLabel: "Neutral",
      launches: [],
      candles15: parseKlines(FALLBACK.m15),
      candles1h: parseKlines(FALLBACK.h1),
      candles5: parseKlines(FALLBACK.m5),
      source: "fallback",
      livePump: false,
    };

    const tasks = {
      sol: getJson("https://www.okx.com/api/v5/market/ticker?instId=SOL-USDT"),
      btc: getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"),
      fund: getJson("https://www.okx.com/api/v5/public/funding-rate?instId=SOL-USDT-SWAP"),
      oi: getJson("https://www.okx.com/api/v5/public/open-interest?instId=SOL-USDT-SWAP"),
      ls: getJson(
        "https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=SOL&period=1H",
      ),
      fng: getJson("https://api.alternative.me/fng/?limit=1"),
      pump: getJson(
        "https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false",
      ),
      pump2: getJson(
        "https://frontend-api-v3.pump.fun/coins?offset=50&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false",
      ),
      live: getJson("https://frontend-api-v3.pump.fun/coins/currently-live?offset=0&limit=20"),
      k15: getJson("https://www.okx.com/api/v5/market/candles?instId=SOL-USDT&bar=15m&limit=300"),
      k1h: getJson("https://www.okx.com/api/v5/market/candles?instId=SOL-USDT&bar=1H&limit=200"),
      k5: getJson("https://www.okx.com/api/v5/market/candles?instId=SOL-USDT&bar=5m&limit=300"),
      cb: getJson("https://api.coinbase.com/v2/prices/SOL-USD/spot"),
    };

    const settled = await Promise.allSettled(Object.values(tasks));
    const keys = Object.keys(tasks) as (keyof typeof tasks)[];
    const bag: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      const r = settled[i]!;
      if (r.status === "fulfilled") {
        bag[k] = r.value;
        sources.push(k);
      }
    });

    const snap: MarketSnapshot = { ...empty, fetchedAt: Date.now(), source: sources.join(",") || "fallback" };

    if (bag.sol && typeof bag.sol === "object") {
      const row = (bag.sol as { data?: Record<string, string>[] }).data?.[0];
      if (row) {
        snap.solUsd = num(row.last, snap.solUsd);
        const open = num(row.open24h, snap.solUsd);
        snap.solChange24h = open ? snap.solUsd / open - 1 : 0;
      }
    }
    if (bag.btc && typeof bag.btc === "object") {
      const row = (bag.btc as { data?: Record<string, string>[] }).data?.[0];
      if (row) {
        snap.btcUsd = num(row.last, snap.btcUsd);
        const open = num(row.open24h, snap.btcUsd);
        snap.btcChange24h = open ? snap.btcUsd / open - 1 : 0;
      }
    }
    if (bag.fund && typeof bag.fund === "object") {
      const row = (bag.fund as { data?: Record<string, string>[] }).data?.[0];
      if (row) snap.fundingSol = num(row.fundingRate);
    }
    if (bag.oi && typeof bag.oi === "object") {
      const row = (bag.oi as { data?: Record<string, string>[] }).data?.[0];
      if (row) snap.oiSolUsd = num(row.oiUsd);
    }
    if (bag.ls && typeof bag.ls === "object") {
      const row = (bag.ls as { data?: string[][] }).data?.[0];
      if (row) snap.longShortSol = num(row[1], 2);
    }
    if (bag.fng && typeof bag.fng === "object") {
      const row = (bag.fng as { data?: { value?: string; value_classification?: string }[] }).data?.[0];
      if (row) {
        snap.fearGreed = num(row.value, 50);
        snap.fearLabel = String(row.value_classification ?? "Neutral");
      }
    }
    const pumpLists = [mapPump(bag.pump), mapPump(bag.pump2), mapPump(bag.live)];
    snap.launches = mergeLaunches(...pumpLists);
    snap.livePump = snap.launches.length > 0;
    if (bag.k15) {
      const c = candlesFromOkx(bag.k15);
      if (c.length > 10) snap.candles15 = c;
    }
    if (bag.k1h) {
      const c = candlesFromOkx(bag.k1h);
      if (c.length > 10) snap.candles1h = c;
    }
    if (bag.k5) {
      const c = candlesFromOkx(bag.k5);
      if (c.length > 10) snap.candles5 = c;
    }
    if (!snap.solUsd && bag.cb && typeof bag.cb === "object") {
      const amt = (bag.cb as { data?: { amount?: string } }).data?.amount;
      snap.solUsd = num(amt, snap.solUsd);
    }
    return snap;
  },
);

export const getMintQuotes = createServerFn({ method: "POST" })
  .validator((input: { mints: string[] }) => input)
  .handler(async ({ data }): Promise<Record<string, number>> => {
    const mints = [...new Set(data.mints.filter((m) => typeof m === "string" && m.length > 20))].slice(0, 5);
    const quotes: Record<string, number> = {};
    await Promise.all(
      mints.map(async (mint) => {
        try {
          const raw = await getJson(`https://frontend-api-v3.pump.fun/coins/${encodeURIComponent(mint)}`, 2200);
          if (!raw || typeof raw !== "object") return;
          const c = raw as Record<string, unknown>;
          const usd = num(c.usd_market_cap ?? c.market_cap_usd ?? c.market_cap);
          if (usd > 0) quotes[mint] = usd;
        } catch {
          /* mint may have died */
        }
      }),
    );
    return quotes;
  });

export type GrokConsult = {
  ok: true;
  narrative_fit: number;
  virality: number;
  community: number;
  timing: number;
  approve: boolean;
  confidence: number;
  risk_flags: string[];
  reason: string;
} | { ok: false; error: string };

export const consultGrok = createServerFn({ method: "POST" })
  .validator((input: { symbol: string; name: string; description: string; metrics: string }) => input)
  .handler(async ({ data }): Promise<GrokConsult> => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false, error: "Grok is not available in this environment" };

    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4.5",
        temperature: 0,
        max_tokens: 320,
        messages: [
          {
            role: "system",
            content:
              "You are NIGHTSHIFT checker+narrative for pump.fun PAPER trading. Be skeptical. Reply ONLY JSON.",
          },
          {
            role: "user",
            content: `Token ${data.name} (${data.symbol})
Description: ${data.description || "none"}
Metrics: ${data.metrics}

Rate 0-1: narrative_fit, virality, community, timing.
approve=false if you find a serious red flag.
confidence 0-1.
risk_flags: string[].
reason: one short sentence.

Reply ONLY JSON:
{"narrative_fit":0,"virality":0,"community":0,"timing":0,"approve":false,"confidence":0,"risk_flags":[],"reason":""}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      if (res.status === 403) {
        return {
          ok: false,
          error: "Grok credits are paused on this app. The five-agent desk still scores locally.",
        };
      }
      return { ok: false, error: `xAI API error ${res.status}` };
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? "";
    try {
      const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const parsed = JSON.parse(cleaned) as Omit<Extract<GrokConsult, { ok: true }>, "ok">;
      return {
        ok: true,
        narrative_fit: Number(parsed.narrative_fit) || 0,
        virality: Number(parsed.virality) || 0,
        community: Number(parsed.community) || 0,
        timing: Number(parsed.timing) || 0,
        approve: Boolean(parsed.approve),
        confidence: Number(parsed.confidence) || 0,
        risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags.map(String).slice(0, 6) : [],
        reason: String(parsed.reason ?? "").slice(0, 240),
      };
    } catch {
      return { ok: false, error: "Could not parse Grok response" };
    }
  });
