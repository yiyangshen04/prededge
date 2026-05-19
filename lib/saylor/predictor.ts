/**
 * Predictor — combines classified signals + structural flags into a
 * probability and a recommendation.
 *
 * Decision tree (priority top→bottom):
 *   1. earningsBlackout || capitalAction      → p=0.15, BUY_NO
 *   2. mixedSignal (BUY ∧ NOBUY same week)    → p=0.45, HOLD
 *   3. NOBUY only                              → p=0.05, BUY_NO
 *   4. BUY only:
 *        base = max(buyHits.weight)
 *        if "Back to Work" hit && prev week NOBUY → p=0.92
 *        else if holidayMonday → p = base * 0.55  (PM window misses)
 *        else                  → p = base
 *        if greenPresent       → p -= 0.10
 *        clamp [0.05, 0.95]
 *        rec = p > 0.70 ? BUY_YES : (p < 0.30 ? BUY_NO : HOLD)
 *   5. no signals                              → p=0.50, HOLD
 *
 * The weights and thresholds come from the 80-week backtest (Strategy E:
 * 87.8% win rate). They can be tuned later; for now we ship the literal
 * report-derived values.
 */

import type {
  PredictorFlags,
  Recommendation,
  SignalHit,
  WeekPrediction,
} from "./types";

export interface PredictorInput {
  weekStart: string;
  weekEnd: string;
  signals: SignalHit[];
  flags: PredictorFlags;
}

const BACK_TO_WORK_RE = /back\s+to\s+work/i;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function bucketRecommendation(p: number): Recommendation {
  if (p > 0.7) return "BUY_YES";
  if (p < 0.3) return "BUY_NO";
  return "HOLD";
}

export function predictWeek(input: PredictorInput): WeekPrediction {
  const { weekStart, weekEnd, signals, flags } = input;

  const buyHits = signals.filter((s) => s.type === "BUY");
  const nobuyHits = signals.filter((s) => s.type === "NOBUY");
  const greenHits = signals.filter((s) => s.type === "GREEN");
  const mixedSignal = flags.mixedSignal || (buyHits.length > 0 && nobuyHits.length > 0);
  const greenPresent = flags.greenPresent || greenHits.length > 0;

  // 1. Structural blockers (earnings / capital action) trump everything.
  if (flags.earningsBlackout) {
    return {
      weekStart,
      weekEnd,
      probability: 0.15,
      recommendation: "BUY_NO",
      breakdown: signals,
      flags: { ...flags, mixedSignal, greenPresent },
      reason: "earnings_blackout",
    };
  }
  if (flags.capitalAction) {
    return {
      weekStart,
      weekEnd,
      probability: 0.2,
      recommendation: "BUY_NO",
      breakdown: signals,
      flags: { ...flags, mixedSignal, greenPresent },
      reason: "capital_action",
    };
  }

  // 2. Mixed signal — Saylor self-contradicts within the week.
  if (mixedSignal) {
    return {
      weekStart,
      weekEnd,
      probability: 0.45,
      recommendation: "HOLD",
      breakdown: signals,
      flags: { ...flags, mixedSignal: true, greenPresent },
      reason: "mixed_signals",
    };
  }

  // 3. Explicit NOBUY only.
  if (nobuyHits.length > 0 && buyHits.length === 0) {
    const max = nobuyHits.reduce((m, h) => Math.max(m, h.weight), 0);
    const p = clamp(1 - max, 0.02, 0.15);
    return {
      weekStart,
      weekEnd,
      probability: p,
      recommendation: "BUY_NO",
      breakdown: signals,
      flags: { ...flags, greenPresent },
      reason: "explicit_nobuy",
    };
  }

  // 4. BUY only.
  if (buyHits.length > 0) {
    const base = buyHits.reduce((m, h) => Math.max(m, h.weight), 0);
    const hasBackToWork = buyHits.some((h) => BACK_TO_WORK_RE.test(h.matchedPhrase));

    let p: number;
    let reason: string;

    if (hasBackToWork && flags.prevWeekNobuy) {
      p = 0.92;
      reason = "back_to_work_pivot";
    } else if (flags.holidayMonday) {
      // Signal is real but PM window misalignment kills the market outcome.
      p = base * 0.55;
      reason = "buy_signal_but_holiday_misalignment";
    } else {
      p = base;
      reason = "buy_signal";
    }

    if (greenPresent) {
      p -= 0.1;
      reason = `${reason}+green_weakening`;
    }

    p = clamp(p, 0.05, 0.95);
    return {
      weekStart,
      weekEnd,
      probability: p,
      recommendation: bucketRecommendation(p),
      breakdown: signals,
      flags: { ...flags, greenPresent },
      reason,
    };
  }

  // 5. Silent week.
  return {
    weekStart,
    weekEnd,
    probability: 0.5,
    recommendation: "HOLD",
    breakdown: signals,
    flags: { ...flags, mixedSignal, greenPresent },
    reason: "no_signals",
  };
}
