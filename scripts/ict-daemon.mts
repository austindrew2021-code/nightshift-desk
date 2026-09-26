/**
 * Always-on hunter for Tokyo Lightsail. GitHub is backup for the phone if HTTPS is down.
 * Serves live JSON on 127.0.0.1:8787 (Caddy terminates HTTPS).
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";

const every = Math.max(8000, Number(process.env.ICT_EVERY_MS || 20_000));
const state = process.env.ICT_STATE_PATH || "ict-state.json";
const liveDir = dirname(state);
const shouldPush = process.env.ICT_PUSH === "1";

function run(cmd: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      stdio: "inherit",
      env: process.env,
      cwd,
      shell: process.platform === "win32",
    });
    p.on("close", (c) => resolve(c ?? 1));
  });
}

function serveLive() {
  const files: Record<string, string> = {
    "/": "ict-state.json",
    "/ict-state.json": "ict-state.json",
    "/ict-klines.json": "ict-klines.json",
    "/ict-last.json": "ict-last.json",
  };
  createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    const path = (req.url || "/").split("?")[0] || "/";
    const file = files[path];
    if (!file) {
      res.statusCode = 404;
      res.end("no");
      return;
    }
    void readFile(join(liveDir, file))
      .then((b) => {
        res.setHeader("Content-Type", "application/json");
        res.end(b);
      })
      .catch(() => {
        res.statusCode = 404;
        res.end("{}");
      });
  }).listen(8787, "127.0.0.1", () => console.log("live http 127.0.0.1:8787"));
}

async function pushLive() {
  if (!shouldPush) return;
  await run("git", ["rebase", "--abort"], liveDir);
  const add = await run("git", ["add", "ict-state.json", "ict-klines.json", "ict-last.json"], liveDir);
  if (add !== 0) return;
  await run("git", ["-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "-c", "user.name=nightshift-vps", "commit", "-m", `vps tick ${new Date().toISOString().slice(11, 19)}Z`], liveDir);
  await run("git", ["push", "--force", "origin", "HEAD:ict-live"], liveDir);
}

async function main() {
  serveLive();
  console.log(`hunt every ${every}ms · state ${state} · push ${shouldPush ? "on" : "off"}`);
  for (;;) {
    const t0 = Date.now();
    const code = await run("npx", ["tsx", "scripts/ict-worker.mts"]);
    if (code !== 0) console.error("tick failed", code);
    else await pushLive();
    const now = Date.now();
    const period = 5 * 60 * 1000;
    const since = now % period;
    const untilBar = since < 8_000 ? every : period - since + 400;
    const heartbeat = Math.max(2_000, every - (now - t0));
    await new Promise((r) => setTimeout(r, Math.min(heartbeat, untilBar)));
  }
}

main();
