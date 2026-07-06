import { NextRequest } from "next/server";
import { setCapitalActionFlag } from "@/lib/saylor/db";
import { enforceRateLimit } from "@/lib/rateLimit";

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
  // Flips a week's capital-action flag (blocks BUY signals) — a DB write, so
  // rate-limit it like the other write routes.
  const limited = enforceRateLimit(request, "saylor-capital-action", 10, 10_000);
  if (limited) return limited;
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
