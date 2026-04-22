import { NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";
import type { PaperTrade } from "@/lib/types";

/**
 * GET /api/trades
 * Query: ?status=open|resolved|all (default all)
 */
export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  const status = request.nextUrl.searchParams.get("status") ?? "all";

  let query = supabase
    .from("paper_trades")
    .select("*")
    .order("created_at", { ascending: false });

  if (status === "open") {
    query = query.eq("status", "open");
  } else if (status === "resolved") {
    query = query.in("status", ["won", "lost", "void"]);
  }

  const { data, error } = await query;

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const trades: PaperTrade[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    conditionId: row.condition_id as string,
    tokenId: row.token_id as string,
    marketQuestion: row.market_question as string,
    outcomeBought: row.outcome_bought as string,
    marketUrl: (row.market_url as string | null) ?? null,
    endDate: (row.end_date as string | null) ?? null,
    usdAmount: Number(row.usd_amount),
    shares: Number(row.shares),
    avgFillPrice: Number(row.avg_fill_price),
    worstFillPrice: Number(row.worst_fill_price),
    fills: (row.fills as PaperTrade["fills"]) ?? [],
    status: row.status as PaperTrade["status"],
    resolvedOutcome: (row.resolved_outcome as string | null) ?? null,
    pnlUsd: row.pnl_usd == null ? null : Number(row.pnl_usd),
    pnlPct: row.pnl_pct == null ? null : Number(row.pnl_pct),
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? null,
  }));

  return Response.json({ trades });
}
