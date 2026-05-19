/**
 * Saylor BTC predictor — domain types.
 *
 * Kept out of `lib/types.ts` to avoid bloating the Polymarket-scanner types.
 * The two domains share `GammaMarket` only at the API client level.
 */

export type SignalType = "BUY" | "NOBUY" | "GREEN";

export type Recommendation = "BUY_YES" | "HOLD" | "BUY_NO";

export type TweetSource = "syndication" | "manual";

export interface SaylorTweet {
  id: string;
  postedAt: string; // ISO timestamp
  text: string;
  url: string | null;
  source: TweetSource;
  fetchedAt: string;
}

export interface SignalHit {
  type: SignalType;
  matchedPhrase: string;
  weight: number;
  tweetId: string | null; // null when hit comes from 8-K text
}

/** Pre-computed flags that the predictor consumes. */
export interface PredictorFlags {
  holidayMonday: boolean;
  earningsBlackout: boolean;
  mixedSignal: boolean;
  capitalAction: boolean;
  greenPresent: boolean;
  prevWeekNobuy: boolean;
}

export interface WeekPrediction {
  weekStart: string; // ISO yyyy-mm-dd, Monday
  weekEnd: string;
  probability: number; // 0-1, P(MSTR buys)
  recommendation: Recommendation;
  breakdown: SignalHit[];
  flags: PredictorFlags;
  reason: string; // short tag like "back_to_work_pivot", "earnings_blackout", etc.
}

/**
 * A historical row from `mstr_weekly_history`.
 * Mirrors the CSV columns 1:1 plus an optional `category` for the "full" CSV.
 */
export interface WeekRecord {
  weekIdx: number;
  startDate: string;
  endDate: string;
  outcome: "YES" | "NO" | "OPEN";
  openPrice: number | null;
  closePrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  avgPrice: number | null;
  volumeUsd: number | null;
  category: string | null; // "precursor" | "series" | "weekly" | null
  conditionId: string | null;
  yesTokenId: string | null;
  slug: string | null;
  title: string | null;
}

export interface CapitalActionFlag {
  weekStart: string;
  flagged: boolean;
  note: string | null;
  flaggedAt: string;
}

export interface BacktestStat {
  strategy: string;
  weeksEvaluated: number;
  wins: number;
  losses: number;
  skipped: number;
  winRate: number; // 0-1
  totalReturn: number; // $/$ basis, e.g. +0.256 = +25.6%
  byWeek: Array<{
    weekStart: string;
    actualOutcome: "YES" | "NO" | "OPEN";
    predictedProbability: number;
    predictedRecommendation: Recommendation;
    pnlPerDollar: number; // +1 win, -1 loss when no position is 0
  }>;
}

/** Live Polymarket market binding for the current week. */
export interface CurrentMarket {
  conditionId: string;
  yesTokenId: string;
  yesPrice: number | null;
  noPrice: number | null;
  question: string;
  slug: string;
  endDate: string | null;
  marketUrl: string;
  fetchedAt: string;
}

/** Shape returned by `GET /api/saylor/current`. */
export interface CurrentResponse {
  prediction: WeekPrediction | null;
  market: CurrentMarket | null;
  tweets: SaylorTweet[];
  signals: SignalHit[];
  capitalAction: CapitalActionFlag | null;
}
