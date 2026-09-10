import type { AgentId, ClosedTrade, TapeEvent } from "./types";

/**
 * Source: @zostaff, 26 Aug 2026 (X article + follow-up video post).
 * Tickers were never released. These numbers are the published book.
 *
 *   start $1,000 at $1,000/SOL  =  1.00 SOL
 *   18,000 launches scanned, 11 fills, daily cap hit
 *   7 stopped −50% in <3m, avg −0.08 SOL  →  −0.56 SOL
 *   4 won, +82 SOL. One 190× from 40s after launch to graduation
 *   net after fees / Jito  ~80 SOL  ≈  $80,000
 *   claimed size cap 0.1 SOL/fill — does not fit +82 SOL of wins
 *     with a single 190×, so the replay trusts the SOL totals
 *   typical other day: 0.5–3 SOL. This day is a tail event.
 */
export const ZOSTAFF_PUBLISHED_START_USD = 1000;
export const ZOSTAFF_PUBLISHED_SOL_USD = 1000;
export const ZOSTAFF_PUBLISHED_START_SOL = 1;
export const ZOSTAFF_PUBLISHED_END_SOL = 80;
export const ZOSTAFF_PUBLISHED_END_USD = 80_000;
export const ZOSTAFF_PUBLISHED_MULTIPLE = 80;
export const ZOSTAFF_SCANNED = 18_000;
export const ZOSTAFF_FILLS = 11;
export const ZOSTAFF_LOSSES = 7;
export const ZOSTAFF_WINS = 4;
export const ZOSTAFF_LOSS_SOL = 0.08;
export const ZOSTAFF_LOSS_TOTAL_SOL = 0.56;
export const ZOSTAFF_WIN_TOTAL_SOL = 82;
export const ZOSTAFF_NET_SOL = 80;
export const ZOSTAFF_FEE_SOL = 2.44; // 81.44 gross − 79 net, so end is 80× start (headline $80k)
export const ZOSTAFF_STOP = 0.5;
export const ZOSTAFF_WINNER_X = 190;
export const ZOSTAFF_GRAD_MCAP = 69_000;
export const ZOSTAFF_CLAIMED_CAP_SOL = 0.1;
/** Residual of the +82 SOL win book after assigning 70 SOL to the 190×. */
export const ZOSTAFF_X190_SOL = 70;
export const ZOSTAFF_RESIDUAL_WIN_SOL = [2.5, 4.5, 5] as const;

export type ZAction =
  | { type: "note"; text: string; tone: "mute" | "warn" }
  | { type: "scan"; symbol: string; text: string }
  | { type: "skip"; symbol: string; text: string }
  | { type: "veto"; symbol: string; text: string }
  | { type: "open"; id: string; symbol: string; name: string; sizeSol: number; entryUsd: number; note: string; agent: AgentId }
  | { type: "mark"; id: string; markUsd: number }
  | { type: "close"; id: string; exitUsd: number; reason: ClosedTrade["reason"]; text: string }
  | { type: "fee"; sol: number; text: string }
  | { type: "scanned"; n: number }
  | { type: "done" };

export interface ZostaffStep {
  tick: number;
  actions: ZAction[];
}

export interface ZostaffFillSpec {
  id: string;
  kind: "loss" | "residual" | "x190";
  source: "published" | "implied";
  pnlSol: number;
  sizeSol: number;
  multiple: number;
  entryUsd: number;
  exitUsd: number;
  openTick: number;
  hold: number;
  agent: AgentId;
  note: string;
}

export interface ZostaffScale {
  startUsd: number;
  solUsd: number;
  startSol: number;
  scale: number;
  targetEndUsd: number;
  targetEndSol: number;
}

const LOSS_OPENS = [18, 34, 50, 98, 114, 168, 216];
const RESIDUAL_SPECS = [
  { open: 68, hold: 16, pnlSol: ZOSTAFF_RESIDUAL_WIN_SOL[0], label: "WIN-A" },
  { open: 136, hold: 18, pnlSol: ZOSTAFF_RESIDUAL_WIN_SOL[1], label: "WIN-B" },
  { open: 184, hold: 20, pnlSol: ZOSTAFF_RESIDUAL_WIN_SOL[2], label: "WIN-C" },
] as const;
const X190_OPEN = 236;
const X190_HOLD = 90;
export const ZOSTAFF_LAST_TICK = X190_OPEN + X190_HOLD + 12;

function finite(n: number, d = 0): number {
  return Number.isFinite(n) ? n : d;
}

function pickSym(live: string[], i: number, fallback: string): string {
  if (!live.length) return fallback;
  return live[i % live.length]!;
}

export function zostaffScale(startUsd: number, solUsd: number): ZostaffScale {
  const start = Math.max(10, finite(startUsd, 1000));
  const sol = Math.max(1, finite(solUsd, 100));
  const startSol = start / sol;
  const scale = startSol / ZOSTAFF_PUBLISHED_START_SOL;
  return {
    startUsd: start,
    solUsd: sol,
    startSol,
    scale,
    targetEndUsd: start * ZOSTAFF_PUBLISHED_MULTIPLE,
    targetEndSol: startSol * ZOSTAFF_PUBLISHED_MULTIPLE,
  };
}

export function zostaffFills(scale: ZostaffScale): ZostaffFillSpec[] {
  const s = scale.scale;
  const fills: ZostaffFillSpec[] = [];

  LOSS_OPENS.forEach((openTick, i) => {
    const pnlSol = -ZOSTAFF_LOSS_SOL * s;
    const sizeSol = ZOSTAFF_LOSS_SOL * s / ZOSTAFF_STOP;
    const entryUsd = 2400 + i * 160;
    fills.push({
      id: `L${String(i + 1).padStart(2, "0")}`,
      kind: "loss",
      source: "published",
      pnlSol,
      sizeSol,
      multiple: 1 - ZOSTAFF_STOP,
      entryUsd,
      exitUsd: entryUsd * (1 - ZOSTAFF_STOP),
      openTick,
      hold: 4,
      agent: "checker",
      note: `published −50% stop · avg −0.08 SOL · ticker unpublished`,
    });
  });

  RESIDUAL_SPECS.forEach((w) => {
    const pnlSol = w.pnlSol * s;
    const sizeSol = ZOSTAFF_CLAIMED_CAP_SOL * s;
    const multiple = 1 + pnlSol / Math.max(1e-9, sizeSol);
    const entryUsd = 1800;
    fills.push({
      id: w.label,
      kind: "residual",
      source: "implied",
      pnlSol,
      sizeSol,
      multiple,
      entryUsd,
      exitUsd: entryUsd * multiple,
      openTick: w.open,
      hold: w.hold,
      agent: "narrative",
      note: `implied split of unpublished +82 SOL win book · ticker unpublished`,
    });
  });

  const pnl190 = ZOSTAFF_X190_SOL * s;
  const size190 = pnl190 / (ZOSTAFF_WINNER_X - 1);
  const entry190 = ZOSTAFF_GRAD_MCAP / ZOSTAFF_WINNER_X;
  fills.push({
    id: "X190",
    kind: "x190",
    source: "published",
    pnlSol: pnl190,
    sizeSol: size190,
    multiple: ZOSTAFF_WINNER_X,
    entryUsd: entry190,
    exitUsd: ZOSTAFF_GRAD_MCAP,
    openTick: X190_OPEN,
    hold: X190_HOLD,
    agent: "narrative",
    note: `published 190× · 40s after launch to graduation (~$${ZOSTAFF_GRAD_MCAP.toLocaleString()} mcap) · ticker unpublished`,
  });

  return fills;
}

/**
 * Rebuild the published 11-fill day, scaled so 1 SOL of start
 * becomes 80 SOL of end — the writeup path. USD uses the live SOL
 * snapshot taken at reset, so $100 at ~$100/SOL is the same 1 SOL
 * stack they started with.
 */
export function buildZostaffPlan(
  startUsd: number,
  solUsd: number,
  liveSymbols: string[],
): ZostaffStep[] {
  const z = zostaffScale(startUsd, solUsd);
  const fills = zostaffFills(z);
  const byTick = new Map<number, ZAction[]>();

  const push = (tick: number, a: ZAction) => {
    const list = byTick.get(tick) ?? [];
    list.push(a);
    byTick.set(tick, list);
  };

  push(0, {
    type: "note",
    tone: "warn",
    text: `from scratch $${z.startUsd.toFixed(0)} = ${z.startSol.toFixed(3)} SOL @ $${z.solUsd.toFixed(2)} · published 1 SOL → 80 SOL`,
  });
  push(1, {
    type: "note",
    tone: "mute",
    text: "hunter attached · 18,000 launches · 11 fills · 7 stopped −50% in <3m · 4 won · one 190×",
  });
  push(2, {
    type: "note",
    tone: "mute",
    text: "published math: −0.56 SOL losses · +82 SOL wins · fees sized so the book ends at 80× start. tickers never released",
  });
  push(3, {
    type: "note",
    tone: "warn",
    text: "claimed 0.1 SOL cap does not fit +82 SOL of wins with one 190×. replay uses the SOL totals. skip tape = live mints",
  });
  push(40, {
    type: "note",
    tone: "warn",
    text: "timing · SOL was bleeding Sunday night · pipeline shut 6 hours · published, not this clock",
  });

  const skipReasons = [
    "no metadata",
    "empty curve",
    "too late on curve",
    "sniper window",
    "high_risk",
  ];
  const vetoReasons = [
    "coordinated buys in first 8s",
    "creator dump risk",
    "bundled wallets",
    "dead tape / bad regime",
  ];

  for (let t = 4; t < ZOSTAFF_LAST_TICK; t += 2) {
    const sym = pickSym(liveSymbols, t, `SCAN${t}`);
    const kind = t % 7 === 0 ? "veto" : "skip";
    const reason =
      kind === "veto"
        ? vetoReasons[(t / 2) % vetoReasons.length]!
        : skipReasons[(t / 2) % skipReasons.length]!;
    push(t, {
      type: kind,
      symbol: sym,
      text: `${kind} ${sym} · ${reason}`,
    });
    const scanned = Math.min(
      ZOSTAFF_SCANNED,
      Math.floor((t / ZOSTAFF_LAST_TICK) * ZOSTAFF_SCANNED),
    );
    push(t, { type: "scanned", n: scanned });
  }

  for (const f of fills) {
    push(f.openTick, {
      type: "open",
      id: f.id,
      symbol: f.id,
      name: f.kind === "x190" ? "unpublished 190×" : f.kind === "loss" ? "unpublished loser" : "unpublished winner",
      sizeSol: f.sizeSol,
      entryUsd: f.entryUsd,
      agent: f.agent,
      note: f.note,
    });
    for (let k = 1; k < f.hold; k++) {
      const p = k / f.hold;
      const eased = f.kind === "x190" ? Math.pow(p, 1.55) : p;
      const mark = f.entryUsd + (f.exitUsd - f.entryUsd) * eased;
      push(f.openTick + k, { type: "mark", id: f.id, markUsd: mark });
    }
    const reason: ClosedTrade["reason"] =
      f.kind === "loss" ? "stop" : f.kind === "x190" ? "trail" : "target";
    const sign = f.pnlSol >= 0 ? "+" : "";
    push(f.openTick + f.hold, {
      type: "close",
      id: f.id,
      exitUsd: f.exitUsd,
      reason,
      text: `${reason} ${f.id} ${sign}${f.pnlSol.toFixed(3)} SOL · ${f.source}`,
    });
  }

  const feeTick = X190_OPEN + X190_HOLD + 4;
  push(feeTick, {
    type: "fee",
    sol: ZOSTAFF_FEE_SOL * z.scale,
    text: `fees + Jito −${(ZOSTAFF_FEE_SOL * z.scale).toFixed(3)} SOL · pins the book to published 80× (writeup rounded 81 SOL to $80k)`,
  });
  push(ZOSTAFF_LAST_TICK - 4, { type: "scanned", n: ZOSTAFF_SCANNED });
  push(ZOSTAFF_LAST_TICK - 2, {
    type: "note",
    tone: "warn",
    text: `complete · 11 fills · book → ${ZOSTAFF_PUBLISHED_MULTIPLE}× start ($${z.targetEndUsd.toFixed(0)}). outlier, not a base rate. typical day 0.5–3 SOL`,
  });
  push(ZOSTAFF_LAST_TICK, { type: "done" });

  return [...byTick.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tick, actions]) => ({ tick, actions }));
}

export function zostaffTapeKind(a: ZAction): TapeEvent["kind"] {
  switch (a.type) {
    case "scan":
      return "scan";
    case "skip":
      return "skip";
    case "veto":
      return "veto";
    case "open":
      return "open";
    case "close":
      return "close";
    default:
      return "note";
  }
}
