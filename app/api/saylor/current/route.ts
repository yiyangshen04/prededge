import { NextRequest } from "next/server";
import {
  getCapitalActionFlag,
  getLatestPrediction,
  listSignalsForWeek,
  listTweets,
} from "@/lib/saylor/db";
import { mondayOf, sundayOf } from "@/lib/saylor/calendar";
import type { CurrentResponse, WeekPrediction } from "@/lib/saylor/types";

export const runtime = "nodejs";

void NextRequest;

/**
 * GET /api/saylor/current
 * Returns the latest cached prediction + recent tweets for the current
 * Monday-week. Does NOT fetch new data — call POST /api/saylor/refresh for
 * that.
 */
export async function GET() {
  const now = new Date();
  const weekStart = mondayOf(now);
  const weekEnd = sundayOf(now);

  try {
    const stored = getLatestPrediction(weekStart);
    let prediction: WeekPrediction | null = null;
    if (stored) {
      let parsed: {
        breakdown?: WeekPrediction["breakdown"];
        flags?: WeekPrediction["flags"];
        reason?: string;
      } = {};
      try {
        parsed = JSON.parse(stored.signalBreakdown);
      } catch {
        parsed = {};
      }
      prediction = {
        weekStart: stored.weekStart,
        weekEnd: stored.weekEnd,
        probability: stored.probability,
        recommendation: stored.recommendation as WeekPrediction["recommendation"],
        breakdown: parsed.breakdown ?? [],
        flags:
          parsed.flags ?? {
            holidayMonday: false,
            earningsBlackout: false,
            mixedSignal: false,
            capitalAction: false,
            greenPresent: false,
            prevWeekNobuy: false,
          },
        reason: parsed.reason ?? "stored",
      };
    }

    const tweets = listTweets({ limit: 30 });
    const signals = listSignalsForWeek(weekStart);
    const capitalAction = getCapitalActionFlag(weekStart);

    const body: CurrentResponse & { weekStart: string; weekEnd: string } = {
      prediction,
      market: null, // populated by POST /refresh
      tweets,
      signals,
      capitalAction,
      weekStart,
      weekEnd,
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
