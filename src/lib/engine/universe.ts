export type IctVenue = "okx" | "kucoin";

export interface IctAssetDef {
  id: string;
  symbol: string;
  name: string;
  venue: IctVenue;
  instId: string;
}

/** Liquid KuCoin USDT-M names. All candles + 24h from KuCoin (live venue). */
export const ICT_ASSETS: IctAssetDef[] = [
  { id: "BTC", symbol: "BTC", name: "Bitcoin", venue: "kucoin", instId: "BTC-USDT" },
  { id: "ETH", symbol: "ETH", name: "Ethereum", venue: "kucoin", instId: "ETH-USDT" },
  { id: "SOL", symbol: "SOL", name: "Solana", venue: "kucoin", instId: "SOL-USDT" },
  { id: "XRP", symbol: "XRP", name: "XRP", venue: "kucoin", instId: "XRP-USDT" },
  { id: "XLM", symbol: "XLM", name: "Stellar", venue: "kucoin", instId: "XLM-USDT" },
  { id: "TAO", symbol: "TAO", name: "Bittensor", venue: "kucoin", instId: "TAO-USDT" },
  { id: "NPC", symbol: "NPC", name: "Non-Playable Coin", venue: "kucoin", instId: "NPC-USDT" },
  { id: "BNB", symbol: "BNB", name: "BNB", venue: "kucoin", instId: "BNB-USDT" },
  { id: "DOGE", symbol: "DOGE", name: "Dogecoin", venue: "kucoin", instId: "DOGE-USDT" },
  { id: "AVAX", symbol: "AVAX", name: "Avalanche", venue: "kucoin", instId: "AVAX-USDT" },
  { id: "LINK", symbol: "LINK", name: "Chainlink", venue: "kucoin", instId: "LINK-USDT" },
  { id: "HYPE", symbol: "HYPE", name: "Hyperliquid", venue: "kucoin", instId: "HYPE-USDT" },
  { id: "SUI", symbol: "SUI", name: "Sui", venue: "kucoin", instId: "SUI-USDT" },
  { id: "ADA", symbol: "ADA", name: "Cardano", venue: "kucoin", instId: "ADA-USDT" },
  { id: "LTC", symbol: "LTC", name: "Litecoin", venue: "kucoin", instId: "LTC-USDT" },
  { id: "HBAR", symbol: "HBAR", name: "Hedera", venue: "kucoin", instId: "HBAR-USDT" },
  { id: "UNI", symbol: "UNI", name: "Uniswap", venue: "kucoin", instId: "UNI-USDT" },
  { id: "NEAR", symbol: "NEAR", name: "NEAR", venue: "kucoin", instId: "NEAR-USDT" },
  { id: "FIL", symbol: "FIL", name: "Filecoin", venue: "kucoin", instId: "FIL-USDT" },
  { id: "ARB", symbol: "ARB", name: "Arbitrum", venue: "kucoin", instId: "ARB-USDT" },
  { id: "INJ", symbol: "INJ", name: "Injective", venue: "kucoin", instId: "INJ-USDT" },
  { id: "DOT", symbol: "DOT", name: "Polkadot", venue: "kucoin", instId: "DOT-USDT" },
  { id: "AAVE", symbol: "AAVE", name: "Aave", venue: "kucoin", instId: "AAVE-USDT" },
  { id: "APT", symbol: "APT", name: "Aptos", venue: "kucoin", instId: "APT-USDT" },
  { id: "TRX", symbol: "TRX", name: "TRON", venue: "kucoin", instId: "TRX-USDT" },
  { id: "SEI", symbol: "SEI", name: "Sei", venue: "kucoin", instId: "SEI-USDT" },
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
  { id: "PEPE", symbol: "PEPE", name: "Pepe", venue: "kucoin", instId: "PEPE-USDT" },
  { id: "PUMP", symbol: "PUMP", name: "Pump.fun", venue: "kucoin", instId: "PUMP-USDT" },
  { id: "TRUMP", symbol: "TRUMP", name: "TRUMP", venue: "kucoin", instId: "TRUMP-USDT" },
  { id: "SHIB", symbol: "SHIB", name: "Shiba", venue: "kucoin", instId: "SHIB-USDT" },
  { id: "BCH", symbol: "BCH", name: "Bitcoin Cash", venue: "kucoin", instId: "BCH-USDT" },
  { id: "ETC", symbol: "ETC", name: "Ethereum Classic", venue: "kucoin", instId: "ETC-USDT" },
  { id: "EIGEN", symbol: "EIGEN", name: "EigenLayer", venue: "kucoin", instId: "EIGEN-USDT" },
  { id: "GRAM", symbol: "GRAM", name: "GRAM", venue: "kucoin", instId: "GRAM-USDT" },
  { id: "DASH", symbol: "DASH", name: "Dash", venue: "kucoin", instId: "DASH-USDT" },
  { id: "WLD", symbol: "WLD", name: "Worldcoin", venue: "kucoin", instId: "WLD-USDT" },
  { id: "KAS", symbol: "KAS", name: "Kaspa", venue: "kucoin", instId: "KAS-USDT" },
  { id: "CAKE", symbol: "CAKE", name: "PancakeSwap", venue: "kucoin", instId: "CAKE-USDT" },
  { id: "CRV", symbol: "CRV", name: "Curve", venue: "kucoin", instId: "CRV-USDT" },
  { id: "PENGU", symbol: "PENGU", name: "Pudgy Penguins", venue: "kucoin", instId: "PENGU-USDT" },
  { id: "LDO", symbol: "LDO", name: "Lido", venue: "kucoin", instId: "LDO-USDT" },
  { id: "RENDER", symbol: "RENDER", name: "Render", venue: "kucoin", instId: "RENDER-USDT" },
  { id: "VET", symbol: "VET", name: "VeChain", venue: "kucoin", instId: "VET-USDT" },
  { id: "FARTCOIN", symbol: "FARTCOIN", name: "Fartcoin", venue: "kucoin", instId: "FARTCOIN-USDT" },
  { id: "VIRTUAL", symbol: "VIRTUAL", name: "Virtuals", venue: "kucoin", instId: "VIRTUAL-USDT" },
  { id: "ZEN", symbol: "ZEN", name: "Horizen", venue: "kucoin", instId: "ZEN-USDT" },
  { id: "BONK", symbol: "BONK", name: "Bonk", venue: "kucoin", instId: "BONK-USDT" },
  { id: "JUP", symbol: "JUP", name: "Jupiter", venue: "kucoin", instId: "JUP-USDT" },
  { id: "S", symbol: "S", name: "Sonic", venue: "kucoin", instId: "S-USDT" },
  { id: "POL", symbol: "POL", name: "Polygon", venue: "kucoin", instId: "POL-USDT" },
  { id: "STX", symbol: "STX", name: "Stacks", venue: "kucoin", instId: "STX-USDT" },
  { id: "IMX", symbol: "IMX", name: "Immutable", venue: "kucoin", instId: "IMX-USDT" },
  { id: "RUNE", symbol: "RUNE", name: "THORChain", venue: "kucoin", instId: "RUNE-USDT" },
  { id: "PENDLE", symbol: "PENDLE", name: "Pendle", venue: "kucoin", instId: "PENDLE-USDT" },
  { id: "JASMY", symbol: "JASMY", name: "Jasmy", venue: "kucoin", instId: "JASMY-USDT" },
  { id: "FLOKI", symbol: "FLOKI", name: "FLOKI", venue: "kucoin", instId: "FLOKI-USDT" },
  { id: "COMP", symbol: "COMP", name: "Compound", venue: "kucoin", instId: "COMP-USDT" },
  { id: "SNX", symbol: "SNX", name: "Synthetix", venue: "kucoin", instId: "SNX-USDT" },
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