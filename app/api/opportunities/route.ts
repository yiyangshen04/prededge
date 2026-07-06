import { NextRequest } from "next/server";
import { listOpportunityRows } from "@/lib/localDb";

export const runtime = "nodejs";

/**
 * GET /api/opportunities — Query historical opportunities across scans.
 * Query params: ?decision=actionable&limit=50&offset=0
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  // Guard limit/offset with Number.isFinite (matching the history route). A
  // NaN from `?limit=abc` would flow into node:sqlite's bound params and throw
  // "datatype mismatch" → an unhandled 500 instead of a clean default.
  const limitRaw = Math.floor(Number(searchParams.get("limit")));
  const offsetRaw = Math.floor(Number(searchParams.get("offset")));
  const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50, 200);
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const decision = searchParams.get("decision");
  const minYieldRaw = searchParams.get("minYield");
  const minYield =
    minYieldRaw != null && Number.isFinite(Number(minYieldRaw))
      ? Number(minYieldRaw)
      : undefined;

  const { data, total } = listOpportunityRows({
    decision: decision ?? undefined,
    minYield,
    limit,
    offset,
  });

  return Response.json({ data, total, limit, offset });
}
