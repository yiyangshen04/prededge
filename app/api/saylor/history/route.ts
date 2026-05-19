import { NextRequest } from "next/server";
import { listWeeks } from "@/lib/saylor/db";

export const runtime = "nodejs";

/**
 * GET /api/saylor/history?limit=200&offset=0
 * Returns rows from `mstr_weekly_history`, newest first.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const limit = Number(searchParams.get("limit") ?? 200);
  const offset = Number(searchParams.get("offset") ?? 0);

  try {
    const { weeks, total } = listWeeks({
      limit: Number.isFinite(limit) ? limit : 200,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return Response.json({ weeks, total });
  } catch (err) {
    console.error("[api/saylor/history] failed:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
