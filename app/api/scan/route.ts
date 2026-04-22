import { NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";
import { runScan } from "@/lib/polymarket/scanner";
import { DEFAULT_SCAN_CONFIG } from "@/lib/polymarket/config";
import { enforceRateLimit } from "@/lib/rateLimit";
import type { Opportunity, ScanRun } from "@/lib/types";

/**
 * POST /api/scan — Trigger a new scan and persist results.
 */
export async function POST(request: NextRequest) {
  const limited = enforceRateLimit(request, "scan", 3, 60_000);
  if (limited) return limited;

  try {
    const result = await runScan(DEFAULT_SCAN_CONFIG);

    // Persist to Supabase
    const supabase = createServerSupabaseClient();

    // Insert scan run
    const { error: scanError } = await supabase.from("scan_runs").insert({
      scan_id: result.scan.scanId,
      markets_scanned: result.scan.marketsScanned,
      candidates_found: result.scan.candidatesFound,
      actionable_count: result.scan.actionableCount,
      observe_count: result.scan.observeCount,
      rejected_count: result.scan.rejectedCount,
      duration_ms: result.scan.durationMs,
      started_at: result.scan.startedAt,
      completed_at: result.scan.completedAt,
    });

    if (scanError) {
      console.error("[api/scan] Failed to insert scan_run:", scanError);
    }

    // Insert opportunities
    if (result.opportunities.length > 0) {
      const rows = result.opportunities.map((o) => ({
        scan_id: result.scan.scanId,
        condition_id: o.conditionId,
        token_id: o.tokenId,
        question: o.question,
        event_slug: o.eventSlug,
        event_title: o.eventTitle,
        outcome: o.outcome,
        side: o.side,
        price: o.price,
        annualized_yield_pct: o.annualizedYieldPct,
        net_return_pct: o.netReturnPct,
        days_to_expiry: o.daysToExpiry,
        near_depth_usd: o.nearDepthUsd,
        slippage_bps: o.slippageBps,
        stability_score: o.stabilityScore,
        decision: o.decision,
        decision_reasons: o.decisionReasons,
        volume_24hr: o.volume24hr,
        liquidity: o.liquidity,
        market_url: o.marketUrl,
        end_date: o.endDate,
        tags: o.tags,
        outcome_tokens: o.outcomeTokens,
        asks: o.asks,
        awaiting_resolution: o.awaitingResolution ?? false,
      }));

      const { error: oppError } = await supabase
        .from("opportunities")
        .insert(rows);

      if (oppError) {
        console.error("[api/scan] Failed to insert opportunities:", oppError);
      }

      // Insert odds snapshots
      const snapshots = result.opportunities.map((o) => ({
        condition_id: o.conditionId,
        token_id: o.tokenId,
        outcome: o.outcome,
        price: o.price,
      }));

      const { error: snapError } = await supabase
        .from("odds_snapshots")
        .insert(snapshots);

      if (snapError) {
        console.error("[api/scan] Failed to insert snapshots:", snapError);
      }
    }

    return Response.json(result);
  } catch (err) {
    console.error("[api/scan] Scan failed:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Scan failed" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/scan — Retrieve the latest scan results.
 * Query params: ?decision=actionable&minYield=10&sortBy=yield
 */
export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  const { searchParams } = request.nextUrl;

  // Get the latest scan run
  const { data: scanData, error: scanError } = await supabase
    .from("scan_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(1)
    .single();

  if (scanError || !scanData) {
    return Response.json(
      { error: "No scan results found. Run a scan first." },
      { status: 404 }
    );
  }

  // Build opportunities query
  let query = supabase
    .from("opportunities")
    .select("*")
    .eq("scan_id", scanData.scan_id);

  const decision = searchParams.get("decision");
  if (decision && decision !== "all") {
    query = query.eq("decision", decision);
  }

  // Note: minYield filtering lives on the client because yield is recomputed
  // at the user's trade size. The DB-stored annualized_yield_pct is the
  // $200 baseline and would filter against a different metric than what
  // the user sees.

  const maxDays = searchParams.get("maxDays");
  if (maxDays) {
    query = query.lte("days_to_expiry", parseFloat(maxDays));
  }

  // Sorting is done client-side: the dashboard re-computes yield at the user's
  // chosen trade size, so DB-level ordering would be wrong. We apply a stable
  // default order here only to make paginated/empty-filter fetches predictable.
  query = query.order("scanned_at", { ascending: false });

  const { data: oppData, error: oppError } = await query;

  if (oppError) {
    return Response.json({ error: oppError.message }, { status: 500 });
  }

  // Map DB rows to API response
  const scan: ScanRun = {
    scanId: scanData.scan_id,
    marketsScanned: scanData.markets_scanned,
    candidatesFound: scanData.candidates_found,
    actionableCount: scanData.actionable_count,
    observeCount: scanData.observe_count,
    rejectedCount: scanData.rejected_count,
    durationMs: scanData.duration_ms,
    startedAt: scanData.started_at,
    completedAt: scanData.completed_at,
  };

  const opportunities: Opportunity[] = (oppData ?? []).map((row: Record<string, unknown>) => ({
    conditionId: row.condition_id as string,
    tokenId: row.token_id as string,
    question: row.question as string,
    eventSlug: row.event_slug as string,
    eventTitle: (row.event_title as string | null) ?? null,
    outcome: row.outcome as string,
    side: ((row.side as string) || "BUY") as "BUY" | "SELL",
    price: Number(row.price),
    annualizedYieldPct: Number(row.annualized_yield_pct),
    netReturnPct: Number(row.net_return_pct),
    daysToExpiry: Number(row.days_to_expiry),
    nearDepthUsd: Number(row.near_depth_usd),
    slippageBps: Number(row.slippage_bps),
    stabilityScore: Number(row.stability_score),
    decision: row.decision as "actionable" | "observe" | "rejected",
    decisionReasons: (row.decision_reasons as string[]) ?? [],
    volume24hr: Number(row.volume_24hr),
    liquidity: Number(row.liquidity),
    marketUrl: row.market_url as string,
    endDate: row.end_date as string | null,
    tags: (row.tags as string[]) ?? [],
    outcomeTokens: (row.outcome_tokens as Record<string, string>) ?? {},
    asks: (row.asks as Array<{ price: number; size: number }>) ?? [],
    awaitingResolution: Boolean(row.awaiting_resolution),
  }));

  return Response.json({ scan, opportunities });
}
