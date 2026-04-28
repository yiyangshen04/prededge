import { NextRequest } from "next/server";
import { listPaperTrades } from "@/lib/localDb";

export const runtime = "nodejs";

/**
 * GET /api/trades
 * Query: ?status=open|resolved|all (default all)
 */
export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status") ?? "all";
  const trades = listPaperTrades(status);

  return Response.json({ trades });
}
