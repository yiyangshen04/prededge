import { NextRequest } from "next/server";
import { enforceRateLimit } from "@/lib/rateLimit";
import {
  isEarningsBlackout,
  isHolidayMonday,
  mondayOf,
  sundayOf,
} from "@/lib/saylor/calendar";
import { classifyTweet } from "@/lib/saylor/classifier";
import {
  getCapitalActionFlag,
  getPrevWeek,
  listSignalsForWeek,
  listTweets,
  savePrediction,
  saveSignals,
  upsertTweet,
} from "@/lib/saylor/db";
import { findCurrentMSTRWeeklyMarket } from "@/lib/saylor/polymarketBinding";
import { predictWeek } from "@/lib/saylor/predictor";
import { fetchSaylorTweets } from "@/lib/saylor/twitterSource";
import type {
  CurrentResponse,
  PredictorFlags,
  SignalHit,
  WeekPrediction,
} from "@/lib/saylor/types";

export const runtime = "nodejs";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * POST /api/saylor/refresh
 * 1. Pull recent tweets from X Syndication (best-effort).
 * 2. Classify any new tweets and persist signals.
 * 3. Aggregate flags (holiday, earnings, prev-week NOBUY, capital action).
 * 4. Run predictor.
 * 5. Fetch live Polymarket YES price for the current weekly market.
 * 6. Persist + return the unified `CurrentResponse`.
 */
export async function POST(request: NextRequest) {
  const limited = enforceRateLimit(request, "saylor-refresh", 5, 60_000);
  if (limited) return limited;

  const now = new Date();
  const weekStart = mondayOf(now);
  const weekEnd = sundayOf(now);

  // 1-2. Tweets + classification (graceful failure — manual paste still works).
  const fetchErrors: string[] = [];
  let fetchedCount = 0;
  try {
    const fresh = await fetchSaylorTweets({ max: 20 });
    for (const t of fresh) {
      upsertTweet(t);
      const hits = classifyTweet(t.text, t.id);
      if (hits.length > 0) {
        // Bucket each tweet's signals into its actual posting week.
        const tweetWeek = mondayOf(new Date(t.postedAt));
        saveSignals(hits, tweetWeek);
      }
      fetchedCount++;
    }
  } catch (err) {
    fetchErrors.push(
      err instanceof Error ? err.message : "Twitter fetch failed"
    );
  }

  // 3. Aggregate flags for THIS week.
  const allSignalsThisWeek = listSignalsForWeek(weekStart);
  const buyHits = allSignalsThisWeek.filter((s) => s.type === "BUY");
  const nobuyHits = allSignalsThisWeek.filter((s) => s.type === "NOBUY");
  const greenHits = allSignalsThisWeek.filter((s) => s.type === "GREEN");

  const prevWeekStart = mondayOf(new Date(now.getTime() - 7 * DAY_MS));
  const prevWeekSignals = listSignalsForWeek(prevWeekStart);
  const prevHadNobuy = prevWeekSignals.some((s) => s.type === "NOBUY");
  const prevWeekRecord = getPrevWeek(weekStart);
  const prevWeekOutcomeNo = prevWeekRecord?.outcome === "NO";
  const prevWeekNobuy = prevHadNobuy || prevWeekOutcomeNo;

  const capitalAction = getCapitalActionFlag(weekStart);

  const flags: PredictorFlags = {
    holidayMonday: isHolidayMonday(now),
    earningsBlackout: isEarningsBlackout(now),
    mixedSignal: buyHits.length > 0 && nobuyHits.length > 0,
    capitalAction: capitalAction?.flagged === true,
    greenPresent: greenHits.length > 0,
    prevWeekNobuy,
  };

  // 4. Predict.
  const dedupedSignals = dedupeByTweetAndPhrase(allSignalsThisWeek);
  const prediction: WeekPrediction = predictWeek({
    weekStart,
    weekEnd,
    signals: dedupedSignals,
    flags,
  });

  // 5. Polymarket live price.
  let market: Awaited<ReturnType<typeof findCurrentMSTRWeeklyMarket>> = null;
  try {
    market = await findCurrentMSTRWeeklyMarket(now);
  } catch (err) {
    fetchErrors.push(
      `Polymarket lookup failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // 6. Persist + reply.
  savePrediction(prediction, {
    yesPrice: market?.yesPrice ?? null,
    conditionId: market?.conditionId ?? null,
  });

  const tweets = listTweets({ limit: 30 });

  const body: CurrentResponse & {
    weekStart: string;
    weekEnd: string;
    fetchedCount: number;
    errors: string[];
  } = {
    prediction,
    market,
    tweets,
    signals: dedupedSignals,
    capitalAction,
    weekStart,
    weekEnd,
    fetchedCount,
    errors: fetchErrors,
  };
  return Response.json(body);
}

/**
 * Same tweet may produce multiple identical signals if refresh is hit twice
 * in the same minute (we persist on every refresh). Dedupe by
 * `(tweetId, matchedPhrase)` for the predictor input.
 */
function dedupeByTweetAndPhrase(hits: SignalHit[]): SignalHit[] {
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
