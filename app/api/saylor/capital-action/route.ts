import { NextRequest } from "next/server";
import { setCapitalActionFlag } from "@/lib/saylor/db";

export const runtime = "nodejs";

/**
 * POST /api/saylor/capital-action
 * Body: { weekStart: string (yyyy-mm-dd), flagged: boolean, note?: string }
 *
 * Marks the given week as having a major capital-market action (ATM
 * offering, restructure, rename, etc.). The predictor blocks BUY signals
 * for flagged weeks.
 */
export async function POST(request: NextRequest) {
  let body: { weekStart?: string; flagged?: boolean; note?: string } = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.weekStart !== "string" || typeof body.flagged !== "boolean") {
    return Response.json(
      { error: "weekStart (string) and flagged (boolean) are required" },
      { status: 400 }
    );
  }
  setCapitalActionFlag({
    weekStart: body.weekStart,
    flagged: body.flagged,
    note: body.note,
  });
  return Response.json({ ok: true });
}
