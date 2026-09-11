#!/usr/bin/env node
/**
 * Flatten the TanStack Start SPA client build into a GitHub Pages tree.
 * Vite writes `dist/client/_shell.html` + hashed assets; Pages wants
 * `index.html` / `404.html` at the artifact root.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = join(ROOT, "dist/client");
const OUT = join(ROOT, "dist/pages");
const BASE = "/nightshift-desk/";

const shellPath = join(CLIENT, "_shell.html");
let html = readFileSync(shellPath);
html = Buffer.from(html.filter((b) => b !== 0)).toString("utf8");
if (!html.includes("NIGHTSHIFT") || !html.includes("<script")) {
  throw new Error("SPA shell is empty or missing the desk bootstrap");
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(CLIENT, OUT, { recursive: true });

writeFileSync(join(OUT, "index.html"), html);
writeFileSync(join(OUT, "404.html"), html);
writeFileSync(join(OUT, ".nojekyll"), "");
writeFileSync(
  join(OUT, "__grok/manifest.webmanifest"),
  JSON.stringify(
    {
      name: "NIGHTSHIFT",
      short_name: "NIGHTSHIFT",
      id: BASE,
      start_url: BASE,
      scope: BASE,
      display: "standalone",
      background_color: "#070b09",
      theme_color: "#070b09",
      icons: [
        {
          src: `${BASE}__grok/icon-180.png`,
          sizes: "180x180",
          type: "image/png",
        },
      ],
    },
    null,
    2,
  ),
);

console.log(`[gh-pages] wrote ${OUT} (${html.length} byte index)`);
