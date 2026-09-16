export type IctVenue = "okx" | "kucoin";

export interface IctAssetDef {
  id: string;
  symbol: string;
  name: string;
  venue: IctVenue;
  instId: string;
}

/** Liquid KuCoin USDT-M names (max lev ≥50 except NPC). Candles from OKX; NPC from KuCoin spot. */
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
  { id: "SUI", symbol: "SUI", name: "Sui", venue: "okx", instId: "SUI-USDT" },
  { id: "ADA", symbol: "ADA", name: "Cardano", venue: "okx", instId: "ADA-USDT" },
  { id: "LTC", symbol: "LTC", name: "Litecoin", venue: "okx", instId: "LTC-USDT" },
  { id: "HBAR", symbol: "HBAR", name: "Hedera", venue: "okx", instId: "HBAR-USDT" },
  { id: "UNI", symbol: "UNI", name: "Uniswap", venue: "okx", instId: "UNI-USDT" },
  { id: "NEAR", symbol: "NEAR", name: "NEAR", venue: "okx", instId: "NEAR-USDT" },
  { id: "FIL", symbol: "FIL", name: "Filecoin", venue: "okx", instId: "FIL-USDT" },
  { id: "ARB", symbol: "ARB", name: "Arbitrum", venue: "okx", instId: "ARB-USDT" },
  { id: "INJ", symbol: "INJ", name: "Injective", venue: "okx", instId: "INJ-USDT" },
  { id: "DOT", symbol: "DOT", name: "Polkadot", venue: "okx", instId: "DOT-USDT" },
  { id: "AAVE", symbol: "AAVE", name: "Aave", venue: "okx", instId: "AAVE-USDT" },
  { id: "APT", symbol: "APT", name: "Aptos", venue: "okx", instId: "APT-USDT" },
  { id: "TRX", symbol: "TRX", name: "TRON", venue: "okx", instId: "TRX-USDT" },
  { id: "SEI", symbol: "SEI", name: "Sei", venue: "okx", instId: "SEI-USDT" },
  { id: "ZEC", symbol: "ZEC", name: "Zcash", venue: "kucoin", instId: "ZEC-USDT" },
  { id: "ENA", symbol: "ENA", name: "Ethena", venue: "kucoin", instId: "ENA-USDT" },
  { id: "XMR", symbol: "XMR", name: "Monero", venue: "kucoin", instId: "XMR-USDT" },
  { id: "WIF", symbol: "WIF", name: "dogwifhat", venue: "kucoin", instId: "WIF-USDT" },
  { id: "ICP", symbol: "ICP", name: "Internet Computer", venue: "kucoin", instId: "ICP-USDT" },
  { id: "FET", symbol: "FET", name: "Fetch.ai", venue: "kucoin", instId: "FET-USDT" },
  { id: "TIA", symbol: "TIA", name: "Celestia", venue: "kucoin", instId: "TIA-USDT" },
  { id: "OP", symbol: "OP", name: "Optimism", venue: "kucoin", instId: "OP-USDT" },
  { id: "ATOM", symbol: "ATOM", name: "Cosmos", venue: "kucoin", instId: "ATOM-USDT" },
  { id: "ONDO", symbol: "ONDO", name: "Ondo", venue: "kucoin", instId: "ONDO-USDT" },
];

export interface ChartBar {
  id: string;
  label: string;
  okx: string;
  kucoin: string;
  foldMs: number;
  limit: number;
}

/** Native venue bars. 10M folded from 5m; 8H folded from 4H on OKX (no 8H kline). */
export const CHART_BARS: ChartBar[] = [
  { id: "1m", label: "1M", okx: "1m", kucoin: "1min", foldMs: 0, limit: 300 },
  { id: "5m", label: "5M", okx: "5m", kucoin: "5min", foldMs: 0, limit: 300 },
  { id: "10m", label: "10M", okx: "5m", kucoin: "5min", foldMs: 10 * 60_000, limit: 300 },
  { id: "15m", label: "15M", okx: "15m", kucoin: "15min", foldMs: 0, limit: 200 },
  { id: "30m", label: "30M", okx: "30m", kucoin: "30min", foldMs: 0, limit: 200 },
  { id: "1H", label: "1H", okx: "1H", kucoin: "1hour", foldMs: 0, limit: 200 },
  { id: "2H", label: "2H", okx: "2H", kucoin: "2hour", foldMs: 0, limit: 180 },
  { id: "4H", label: "4H", okx: "4H", kucoin: "4hour", foldMs: 0, limit: 180 },
  { id: "8H", label: "8H", okx: "4H", kucoin: "8hour", foldMs: 8 * 3600_000, limit: 180 },
  { id: "1D", label: "1D", okx: "1D", kucoin: "1day", foldMs: 0, limit: 200 },
  { id: "1W", label: "1W", okx: "1W", kucoin: "1week", foldMs: 0, limit: 120 },
  { id: "MN", label: "MN", okx: "1M", kucoin: "1month", foldMs: 0, limit: 80 },
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