/**
 * Optional 8s loop if you ever have a box that stays on (PC / VPS).
 * GitHub Actions cannot tick this fast. Same state file as the worker.
 *   ICT_STATE_PATH=./ict-state.json npx tsx scripts/ict-daemon.mts
 */
import { spawn } from "node:child_process";

const every = Math.max(5000, Number(process.env.ICT_EVERY_MS || 8000));

function once(): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("npx", ["tsx", "scripts/ict-worker.mts"], {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    p.on("close", (c) => resolve(c ?? 1));
  });
}

async function main() {
  for (;;) {
    const t0 = Date.now();
    const code = await once();
    if (code !== 0) console.error("tick failed", code);
    const wait = Math.max(1000, every - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
  }
}

main();
