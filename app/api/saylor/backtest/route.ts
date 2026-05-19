import { NextRequest } from "next/server";
import { listWeeks } from "@/lib/saylor/db";
import type { BacktestStat, Recommendation } from "@/lib/saylor/types";

export const runtime = "nodejs";

void NextRequest;

/**
 * GET /api/saylor/backtest
 *
 * Lightweight backtest replay: rather than re-running the predictor against
 * synthesized tweet inputs (we don't have a tweet archive seeded yet), this
 * route computes the baseline "always-BUY-YES" win rate from the historical
 * outcomes. The 87.8% figure from the report assumes the strict Strategy E
 * — until tweets are imported alongside, we expose the simpler baseline so
 * the UI panel has something to display.
 *
 * Once a tweet archive is loaded, we'll switch this to a true replay.
 */
export async function GET() {
  const { weeks } = listWeeks({ limit: 500 });

  const settled = weeks.filter((w) => w.outcome === "YES" || w.outcome === "NO");
  const yesCount = settled.filter((w) => w.outcome === "YES").length;
  const noCount = settled.filter((w) => w.outcome === "NO").length;

  const winRate = settled.length === 0 ? 0 : yesCount / settled.length;

  // Per-$1: betting YES at avg_price * $1 returns $1 on YES, $0 on NO.
  let pnlTotal = 0;
  const byWeek: BacktestStat["byWeek"] = [];
  for (const w of settled) {
    const entry = w.openPrice ?? w.avgPrice ?? 0.5;
    const win = w.outcome === "YES";
    const pnlPerDollar = win ? (1 - entry) / entry : -1;
    pnlTotal += pnlPerDollar;
    const recommendation: Recommendation = "BUY_YES";
    byWeek.push({
      weekStart: w.startDate,
      actualOutcome: w.outcome,
      predictedProbability: 0.795, // base rate from the report (79.5% YES)
      predictedRecommendation: recommendation,
      pnlPerDollar,
    });
  }

  const stat: BacktestStat = {
    strategy: "F-baseline (always BUY_YES)",
    weeksEvaluated: settled.length,
    wins: yesCount,
    losses: noCount,
    skipped: weeks.length - settled.length,
    winRate,
    totalReturn: settled.length === 0 ? 0 : pnlTotal / settled.length,
    byWeek,
  };

  return Response.json(stat);
}
