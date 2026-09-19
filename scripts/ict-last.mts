/**
 * KuCoin USDT-M last only — cheap publish so the phone marks on KuCoin, not OKX.
 */
import { writeFileSync } from "node:fs";
import { fetchKucoinAllLast } from "../src/lib/market/kucoin-hot.ts";

const PATH = process.env.ICT_LAST_PATH || "ict-last.json";

const px = await fetchKucoinAllLast();
writeFileSync(PATH, JSON.stringify({ t: Date.now(), src: "kucoin-fut", px }));
console.log(JSON.stringify({ t: Date.now(), n: Object.keys(px).length, SOL: px.SOL, DASH: px.DASH, XMR: px.XMR, BTC: px.BTC }));
