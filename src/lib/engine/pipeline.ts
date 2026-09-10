import { AGENT_META, MIN_SCORE, type AgentId, type Launch, type MarketSnapshot, type ScoredToken } from "./types";

export function curvePctFromMcap(usd: number): number {
  return Math.max(0, Math.min(99, (usd / 69000) * 100));
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function estimateUniqueBuyers(realSol: number, replies: number, usdMcap: number): number {
  const fromSol = realSol > 0 ? realSol / 0.02 : 0;
  const fromMcap = Math.log10(Math.max(1, usdMcap)) * 2.4;
  return Math.max(1, Math.round(fromSol + fromMcap * 0.35 + replies * 0.4));
}

export function regimeScore(m: MarketSnapshot | null): number {
  if (!m) return 0.5;
  const fng = m.fearGreed / 100;
  const fund = m.fundingSol;
  const solCh = m.solChange24h;
  return clamp01(0.42 + (fng - 0.35) * 0.35 - Math.abs(fund) * 10 + solCh * 0.4);
}

export function scoreLive(l: Launch, timing: number): ScoredToken {
  const ageMin = Math.max(0, (Date.now() - l.createdAt) / 60000);
  const curvePct = curvePctFromMcap(l.usdMcap);
  const uniqueBuyers = Math.max(1, l.uniqueBuyers);
  const hasMeta = Boolean(l.name && l.symbol && l.symbol !== "?" && l.name !== "unknown");
  const social =
    ((l.twitter ? 1 : 0) + (l.website ? 1 : 0) + (l.telegram ? 1 : 0)) / 3;

  let skipReason: string | undefined;
  if (!hasMeta) skipReason = "no metadata";
  else if (l.complete) skipReason = "already graduated";
  else if (uniqueBuyers < 5) skipReason = "empty curve";
  else if (curvePct >= 40) skipReason = "too late on curve";
  else if (ageMin < 2) skipReason = "sniper window";
  else if (ageMin > 120) skipReason = "stale launch";

  const diversity = clamp01(uniqueBuyers / 18);
  const curveHealth = clamp01((1 - Math.abs(curvePct - 18) / 45) * (uniqueBuyers >= 8 ? 1 : 0.72));
  const risk = clamp(
    2 +
      (l.twitter ? 0 : 1.5) +
      (uniqueBuyers < 6 ? 2.1 : 0) +
      (curvePct > 35 ? 1.3 : 0) +
      (social < 0.3 ? 0.9 : 0) +
      (l.replies === 0 && uniqueBuyers < 8 ? 0.8 : 0),
    1,
    10,
  );
  const narrativeFit = clamp01(
    0.32 + social * 0.38 + (l.replies > 4 ? 0.18 : 0) + (l.description.length > 24 ? 0.12 : 0),
  );
  const virality = clamp01(social * 0.4 + (l.replies > 8 ? 0.3 : 0) + (curvePct > 5 && curvePct < 30 ? 0.2 : 0));
  const community = clamp01(social * 0.55 + (l.replies > 6 ? 0.3 : 0));
  const metrics = clamp01((1 - risk / 10) * 0.45 + curveHealth * 0.3 + diversity * 0.25);
  const score =
    0.3 * (1 - risk / 10) + 0.25 * narrativeFit + 0.15 * clamp01(timing) + 0.3 * metrics;

  let vetoReason: string | undefined;
  if (!skipReason) {
    if (risk > 7) skipReason = "high_risk";
    else if (score < MIN_SCORE) skipReason = "low_score";
    else if (diversity < 0.25 && uniqueBuyers < 9) vetoReason = "concentrated buyers";
    else if (timing < 0.32) vetoReason = "dead tape / bad regime";
  }

  return {
    launch: l,
    ageMin,
    curvePct,
    uniqueBuyers,
    risk,
    social,
    curveHealth,
    diversity,
    narrativeFit,
    virality,
    community,
    timingScore: clamp01(timing),
    score,
    approved: !skipReason && !vetoReason && score >= MIN_SCORE,
    skipReason,
    vetoReason,
    trueEdge: score,
  };
}

export function agentLine(id: AgentId, token: ScoredToken): string {
  switch (id) {
    case "hunter":
      return `curve ${token.curvePct.toFixed(0)}% · buyers ~${token.uniqueBuyers} · ${token.ageMin.toFixed(1)}m`;
    case "auditor":
      return `risk ${token.risk.toFixed(1)} · organic ${(token.diversity * 100).toFixed(0)}%`;
    case "narrative":
      return `fit ${token.narrativeFit.toFixed(2)} · viral ${token.virality.toFixed(2)}`;
    case "timing":
      return `regime ${token.timingScore.toFixed(2)}`;
    case "checker":
      return token.vetoReason
        ? `veto · ${token.vetoReason}`
        : token.approved
          ? `approve ${token.score.toFixed(2)}`
          : `hold ${token.skipReason ?? "no"}`;
  }
}

export { AGENT_META };
