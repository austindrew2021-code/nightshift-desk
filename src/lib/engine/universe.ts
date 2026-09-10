export type IctVenue = "okx" | "kucoin";

export interface IctAssetDef {
  id: string;
  symbol: string;
  name: string;
  venue: IctVenue;
  instId: string;
}

/** Liquid names with public 15m candles. NPC is KuCoin; majors are OKX. */
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

export interface IctBook {
  id: string;
  symbol: string;
  name: string;
  last: number;
  change24h: number;
  candles15: import("./types").Candle[];
  source: string;
}
