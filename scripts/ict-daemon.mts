/**
 * Always-on hunter for a Singapore VPS. GitHub cron is backup only.
 *   ICT_STATE_PATH=/home/nightshift/live/ict-state.json ICT_PUSH=1 npx tsx scripts/ict-daemon.mts
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";

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

async function pushLive() {
  if (!shouldPush) return;
  await run("git", ["rebase", "--abort"], liveDir);
  const add = await run("git", ["add", "ict-state.json", "ict-klines.json", "ict-last.json"], liveDir);
  if (add !== 0) return;
  await run("git", ["-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "-c", "user.name=nightshift-vps", "commit", "-m", `vps tick ${new Date().toISOString().slice(11, 19)}Z`], liveDir);
  await run("git", ["push", "--force", "origin", "HEAD:ict-live"], liveDir);
}

async function main() {
  console.log(`hunt every ${every}ms · state ${state} · push ${shouldPush ? "on" : "off"}`);
  for (;;) {
    const t0 = Date.now();
    const code = await run("npx", ["tsx", "scripts/ict-worker.mts"]);
    if (code !== 0) console.error("tick failed", code);
    else await pushLive();
    const wait = Math.max(2000, every - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
  }
}

main();
