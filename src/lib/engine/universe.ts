export type IctVenue = "okx" | "kucoin";

export interface IctAssetDef {
  id: string;
  symbol: string;
  name: string;
  venue: IctVenue;
  instId: string;
}

/** Liquid names with public candles. NPC is KuCoin; majors are OKX. */
export const ICT_ASSETS: IctAssetDef[] = [
  { id: "BTC", symbol: "BTC", name: "Bitcoin", venue: "okx", instId: "BTC-USDT" },
  { id: "ETH", symbol: "ETH", name: "Ethereum", venue: "okx", instId: "ETH-USDT" },
  { id: "SOL", symbol: "SOL", name: "Solana", venue: "okx", instId: "SOL-USDT" },
  { id: "XRP", symbol: "XRP", name: "XRP", venue: "okx", instId: "XRP-USDT" },
  { id: "XLM", symbol: "XLM", name: "Stellar", venue: "okx", instId: "XLM-USDT" },
  { id: "TAO", symbol: "TAO", name: "Bittensor", venue: "okx", instId: "TAO-USDT" },
  { id: "NPC", symbol: "NPC", name: "Non-Playable Coin", venue: "kucoin", instId: "NPC-USDT" },
  { id: "BNB", symbol: "BNB", name: "BNB", venue: "okx", instId: "BNB-USDT" },
  { id: "DOGE", symbol: "DOGE", name: "Dogecoin", venue: "okx", instId: "DOGE-USDT" },
  { id: "AVAX", symbol: "AVAX", name: "Avalanche", venue: "okx", instId: "AVAX-USDT" },
  { id: "LINK", symbol: "LINK", name: "Chainlink", venue: "okx", instId: "LINK-USDT" },
  { id: "HYPE", symbol: "HYPE", name: "Hyperliquid", venue: "okx", instId: "HYPE-USDT" },
];

export interface ChartBar {
  id: string;
  label: string;
  okx: string;
  kucoin: string;
  foldMs: number;
  limit: number;
}

/** Native venue bars. 10M is folded from 5m — OKX/KuCoin have no 10m kline. */
export const CHART_BARS: ChartBar[] = [
  { id: "1m", label: "1M", okx: "1m", kucoin: "1min", foldMs: 0, limit: 300 },
  { id: "5m", label: "5M", okx: "5m", kucoin: "5min", foldMs: 0, limit: 300 },
  { id: "10m", label: "10M", okx: "5m", kucoin: "5min", foldMs: 10 * 60_000, limit: 300 },
  { id: "15m", label: "15M", okx: "15m", kucoin: "15min", foldMs: 0, limit: 200 },
  { id: "30m", label: "30M", okx: "30m", kucoin: "30min", foldMs: 0, limit: 200 },
  { id: "1H", label: "1H", okx: "1H", kucoin: "1hour", foldMs: 0, limit: 200 },
  { id: "4H", label: "4H", okx: "4H", kucoin: "4hour", foldMs: 0, limit: 120 },
];

export interface IctBook {
  id: string;
  symbol: string;
  name: string;
  last: number;
  change24h: number;
  candles15: import("./types").Candle[];
  candles5?: import("./types").Candle[];
  candles1h?: import("./types").Candle[];
  source: string;
}

export interface ChartTape {
  id: string;
  last: number;
  candles: import("./types").Candle[];
  source: string;
  bar: string;
}