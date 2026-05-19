import { NextRequest } from "next/server";
import { enforceRateLimit } from "@/lib/rateLimit";
import { mondayOf, sundayOf } from "@/lib/saylor/calendar";
import { classifyTweet } from "@/lib/saylor/classifier";
import {
  ensureSeeded,
  getCapitalActionFlag,
  listTweets,
  savePrediction,
  saveSignals,
  upsertTweet,
} from "@/lib/saylor/db";
import { resolveEvaluation } from "@/lib/saylor/evaluate";
import { findCurrentMSTRWeeklyMarket } from "@/lib/saylor/polymarketBinding";
import { fetchSaylorTweets } from "@/lib/saylor/twitterSource";
import type { CurrentResponse } from "@/lib/saylor/types";

export const runtime = "nodejs";

/**
 * POST /api/saylor/refresh
 * 1. Seed the DB on first use, then pull recent tweets from X Syndication
 *    (best-effort — manual paste still works if it fails).
 * 2. Classify any new tweets and persist signals into their posting week.
 * 3. Evaluate the current week (falling back to the latest signal week) via
 *    the shared resolveEvaluation() helper.
 * 4. Fetch live Polymarket YES price for the current weekly market.
 * 5. Persist + return the unified `CurrentResponse`.
 */
export async function POST(request: NextRequest) {
  const limited = enforceRateLimit(request, "saylor-refresh", 5, 60_000);
  if (limited) return limited;

  const now = new Date();
  const weekStart = mondayOf(now);
  const weekEnd = sundayOf(now);

  ensureSeeded();

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

  // 3. Evaluate (shared with GET /current).
  const evaluated = resolveEvaluation(now);
  const capitalAction = getCapitalActionFlag(evaluated.evaluationWeek);

  // 4. Polymarket live price.
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

  // 5. Persist the prediction for the evaluated week + reply.
  savePrediction(evaluated.prediction, {
    yesPrice: market?.yesPrice ?? null,
    conditionId: market?.conditionId ?? null,
  });

  const tweets = listTweets({ limit: 30 });

  const body: CurrentResponse & {
    weekStart: string;
    weekEnd: string;
    evaluationWeek: string;
    evaluationWeekEnd: string;
    isCurrentWeek: boolean;
    fetchedCount: number;
    errors: string[];
  } = {
    prediction: evaluated.prediction,
    market,
    tweets,
    signals: evaluated.signals,
    capitalAction,
    weekStart,
    weekEnd,
    evaluationWeek: evaluated.evaluationWeek,
    evaluationWeekEnd: evaluated.evaluationWeekEnd,
    isCurrentWeek: evaluated.isCurrentWeek,
    fetchedCount,
    errors: fetchErrors,
  };
  return Response.json(body);
}
