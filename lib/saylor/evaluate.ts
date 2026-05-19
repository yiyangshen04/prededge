/**
 * Shared week-evaluation logic.
 *
 * Aggregates the structural flags (holiday / earnings / capital action /
 * prev-week NOBUY) and the classified signals for a given Monday week, then
 * runs the predictor. Pure of network I/O — it only reads what's already in
 * the DB — so both GET /current (live recompute) and POST /refresh (after
 * fetching fresh tweets) call it and can never drift apart.
 */

import {
  isEarningsBlackout,
  isHolidayMonday,
  mondayOf,
  sundayOf,
} from "./calendar";
import {
  getCapitalActionFlag,
  getPrevWeek,
  latestSignalWeek,
  listSignalsForWeek,
} from "./db";
import { predictWeek } from "./predictor";
import type { PredictorFlags, SignalHit, WeekPrediction } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The same tweet can produce identical signal rows if refresh runs twice in a
 * week (we persist on every refresh). Dedupe by `(tweetId, matchedPhrase)`.
 */
export function dedupeSignals(hits: SignalHit[]): SignalHit[] {
  const seen = new Set<string>();
  const out: SignalHit[] = [];
  for (const h of hits) {
    const k = `${h.tweetId ?? ""}|${h.matchedPhrase}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

export interface WeekEvaluation {
  prediction: WeekPrediction;
  signals: SignalHit[];
}

/**
 * Aggregate flags + run the predictor for one Monday week, reading signals and
 * flags from the DB. Holiday / earnings checks are anchored to the week's own
 * Monday (not "now"), so evaluating a past week stays correct.
 */
export function evaluateWeek(weekStart: string): WeekEvaluation {
  const weekEnd = sundayOf(new Date(weekStart + "T00:00:00Z"));

  const all = listSignalsForWeek(weekStart);
  const signals = dedupeSignals(all);
  const buyHits = signals.filter((s) => s.type === "BUY");
  const nobuyHits = signals.filter((s) => s.type === "NOBUY");
  const greenHits = signals.filter((s) => s.type === "GREEN");

  const weekStartMs = new Date(weekStart + "T00:00:00Z").getTime();
  const refDate = new Date(weekStartMs);
  const prevWeekStart = mondayOf(new Date(weekStartMs - 7 * DAY_MS));
  const prevWeekSignals = listSignalsForWeek(prevWeekStart);
  const prevHadNobuy = prevWeekSignals.some((s) => s.type === "NOBUY");
  const prevWeekRecord = getPrevWeek(weekStart);
  const prevWeekOutcomeNo = prevWeekRecord?.outcome === "NO";
  const prevWeekNobuy = prevHadNobuy || prevWeekOutcomeNo;

  const capitalAction = getCapitalActionFlag(weekStart);

  const flags: PredictorFlags = {
    holidayMonday: isHolidayMonday(refDate),
    earningsBlackout: isEarningsBlackout(refDate),
    mixedSignal: buyHits.length > 0 && nobuyHits.length > 0,
    capitalAction: capitalAction?.flagged === true,
    greenPresent: greenHits.length > 0,
    prevWeekNobuy,
  };

  const prediction = predictWeek({ weekStart, weekEnd, signals, flags });
  return { prediction, signals };
}

export interface ResolvedEvaluation extends WeekEvaluation {
  /** The week actually evaluated (current week, or latest week with signals). */
  evaluationWeek: string;
  evaluationWeekEnd: string;
  /** True when evaluationWeek is the current Monday week. */
  isCurrentWeek: boolean;
}

/**
 * Evaluate the current week if it has any signals; otherwise fall back to the
 * most recent week that does, so the gauge reflects Saylor's latest actual
 * activity instead of a flat "no signals → 50%" when the current week is still
 * silent. Returns the current week unchanged if no signals exist anywhere.
 */
export function resolveEvaluation(now: Date = new Date()): ResolvedEvaluation {
  const currentWeek = mondayOf(now);
  const currentSignals = listSignalsForWeek(currentWeek);

  let evaluationWeek = currentWeek;
  if (currentSignals.length === 0) {
    const latest = latestSignalWeek();
    if (latest) evaluationWeek = latest;
  }

  const { prediction, signals } = evaluateWeek(evaluationWeek);
  return {
    prediction,
    signals,
    evaluationWeek,
    evaluationWeekEnd: sundayOf(new Date(evaluationWeek + "T00:00:00Z")),
    isCurrentWeek: evaluationWeek === currentWeek,
  };
}
