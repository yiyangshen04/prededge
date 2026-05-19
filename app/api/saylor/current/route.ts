import {
  ensureSeeded,
  getCapitalActionFlag,
  listTweets,
} from "@/lib/saylor/db";
import { resolveEvaluation } from "@/lib/saylor/evaluate";
import { mondayOf, sundayOf } from "@/lib/saylor/calendar";
import type { CurrentResponse } from "@/lib/saylor/types";

export const runtime = "nodejs";

/**
 * GET /api/saylor/current
 * Recomputes the prediction live from the signals currently in the DB. Does
 * NOT hit the network — call POST /api/saylor/refresh to pull fresh tweets.
 *
 * Seeds the DB from the committed tweet snapshot on first use, then evaluates
 * the current week; if the current week has no Saylor activity yet, it falls
 * back to the most recent week that does, so the gauge shows a real
 * tweet-derived probability instead of the flat 50% default.
 */
export async function GET() {
  const now = new Date();
  const weekStart = mondayOf(now);
  const weekEnd = sundayOf(now);

  try {
    ensureSeeded();

    const evaluated = resolveEvaluation(now);
    const capitalAction = getCapitalActionFlag(evaluated.evaluationWeek);
    const tweets = listTweets({ limit: 30 });

    const body: CurrentResponse & {
      weekStart: string;
      weekEnd: string;
      evaluationWeek: string;
      evaluationWeekEnd: string;
      isCurrentWeek: boolean;
    } = {
      prediction: evaluated.prediction,
      market: null, // populated by POST /refresh
      tweets,
      signals: evaluated.signals,
      capitalAction,
      weekStart,
      weekEnd,
      evaluationWeek: evaluated.evaluationWeek,
      evaluationWeekEnd: evaluated.evaluationWeekEnd,
      isCurrentWeek: evaluated.isCurrentWeek,
    };
    return Response.json(body);
  } catch (err) {
    console.error("[api/saylor/current] failed:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
