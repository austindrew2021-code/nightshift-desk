/**
 * Banking policies — moving realised gains out of the trading book into a vault
 * that cannot be lost.
 *
 * What banking can and cannot do, so nobody expects the wrong thing:
 *  - It CANNOT raise expected return. Every dollar vaulted is a dollar no longer
 *    compounding, so with positive expectancy banking lowers the mean outcome.
 *  - It CAN raise the MEDIAN outcome and cut ruin sharply, because it converts a
 *    lucky path into cash before a losing run can give it back.
 *  - With expectancy at or near zero it is the only thing that matters: the book
 *    is a coin flip, so the question is purely how much you keep.
 *
 * Every policy is a pure function of the ledger, so they are testable and can be
 * resampled thousands of times without touching the engine.
 */

export interface BankState {
  /** Cash in the trading book. */
  cash: number;
  /** Vaulted, never risked again. */
  banked: number;
  /** Highest equity (cash + banked) seen so far. */
  peak: number;
  /** Where the account started. */
  start: number;
}

export interface BankPolicy {
  id: string;
  label: string;
  /** How much to move from cash to the vault right now. */
  take(s: BankState): number;
}

/** Never bank. Full compounding, full exposure. */
export const NO_BANK: BankPolicy = {
  id: "none",
  label: "no banking",
  take: () => 0,
};

/**
 * The shipped rule: vault 50% of every whole $100 of lifetime gain, never
 * letting the book fall below 25% of start.
 */
export function fixedStep(stepUsd = 100, rate = 0.5, floorPct = 0.25): BankPolicy {
  return {
    id: `step${stepUsd}x${rate}`,
    label: `bank ${(rate * 100).toFixed(0)}% per $${stepUsd} gained`,
    take(s) {
      const lifetime = s.cash + s.banked - s.start;
      if (lifetime < stepUsd) return 0;
      const target = Math.floor(lifetime / stepUsd) * (stepUsd * rate);
      const room = Math.max(0, s.cash - s.start * floorPct);
      return Math.min(Math.max(0, target - s.banked), room);
    },
  };
}

/**
 * High-water ratchet: every time equity sets a new peak, vault `rate` of the
 * amount by which the peak grew. Banks continuously on the way up instead of in
 * $100 jumps, so it captures a run that reverses mid-step.
 */
export function ratchet(rate = 0.35, floorPct = 0.5): BankPolicy {
  return {
    id: `ratchet${rate}`,
    label: `ratchet ${(rate * 100).toFixed(0)}% of each new high`,
    take(s) {
      const eq = s.cash + s.banked;
      if (eq <= s.peak) return 0;
      const gain = eq - s.peak;
      const room = Math.max(0, s.cash - s.start * floorPct);
      return Math.min(gain * rate, room);
    },
  };
}

/**
 * Bank at calculated multiples of the starting stake: at 2x vault enough to make
 * the original stake risk-free, then take a slice at each further multiple. This
 * is the "never lose the initial $100" policy.
 */
export function atMultiples(multiples = [2, 3, 5, 8], rate = 0.5, floorPct = 0.5): BankPolicy {
  return {
    id: `mult${multiples.join("-")}`,
    label: `bank ${(rate * 100).toFixed(0)}% at ${multiples.join("x, ")}x`,
    take(s) {
      const eq = s.cash + s.banked;
      let target = 0;
      for (const m of multiples) {
        if (eq >= s.start * m) target = Math.max(target, s.start * (m - 1) * rate);
      }
      const room = Math.max(0, s.cash - s.start * floorPct);
      return Math.min(Math.max(0, target - s.banked), room);
    },
  };
}

/**
 * Secure the stake first, then ratchet: vault the full original stake the moment
 * equity doubles, and ratchet a slice of every new high after that. Caps the
 * worst case at "lost the profits, kept the stake".
 */
export function stakeFirst(rate = 0.3): BankPolicy {
  const r = ratchet(rate, 0.5);
  return {
    id: `stakefirst${rate}`,
    label: `secure stake at 2x, then ratchet ${(rate * 100).toFixed(0)}%`,
    take(s) {
      const eq = s.cash + s.banked;
      if (s.banked < s.start && eq >= s.start * 2) {
        return Math.min(s.start - s.banked, Math.max(0, s.cash - s.start * 0.5));
      }
      return s.banked >= s.start ? r.take(s) : 0;
    },
  };
}

export const POLICIES: BankPolicy[] = [
  NO_BANK,
  fixedStep(100, 0.5),
  ratchet(0.35),
  ratchet(0.6),
  atMultiples([2, 3, 5, 8], 0.5),
  stakeFirst(0.3),
];

/** Apply a policy once, after a trade has settled. Mutates and returns state. */
export function applyBanking(s: BankState, p: BankPolicy): BankState {
  const eq = s.cash + s.banked;
  const take = Math.min(p.take(s), s.cash);
  if (take >= 1) {
    s.banked += take;
    s.cash -= take;
  }
  s.peak = Math.max(s.peak, eq);
  return s;
}
