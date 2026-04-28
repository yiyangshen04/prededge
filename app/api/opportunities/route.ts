import { NextRequest } from "next/server";
import { listOpportunityRows } from "@/lib/localDb";

export const runtime = "nodejs";

/**
 * GET /api/opportunities — Query historical opportunities across scans.
 * Query params: ?decision=actionable&limit=50&offset=0
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);
  const offset = parseInt(searchParams.get("offset") || "0");
  const decision = searchParams.get("decision");
  const minYieldRaw = searchParams.get("minYield");
  const minYield = minYieldRaw == null ? undefined : Number(minYieldRaw);

  const { data, total } = listOpportunityRows({
    decision: decision ?? undefined,
    minYield,
    limit,
    offset,
  });

  return Response.json({ data, total, limit, offset });
}
