import { NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";

/**
 * GET /api/opportunities — Query historical opportunities across scans.
 * Query params: ?decision=actionable&limit=50&offset=0
 */
export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  const { searchParams } = request.nextUrl;

  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);
  const offset = parseInt(searchParams.get("offset") || "0");

  let query = supabase
    .from("opportunities")
    .select("*", { count: "exact" })
    .order("scanned_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const decision = searchParams.get("decision");
  if (decision && decision !== "all") {
    query = query.eq("decision", decision);
  }

  const minYield = searchParams.get("minYield");
  if (minYield) {
    query = query.gte("annualized_yield_pct", parseFloat(minYield));
  }

  const { data, error, count } = await query;

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ data, total: count, limit, offset });
}
