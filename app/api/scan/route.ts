import { NextRequest } from "next/server";
import {
  getLatestScanRun,
  listOpportunitiesForScan,
  persistScanResult,
} from "@/lib/localDb";
import { runScan } from "@/lib/polymarket/scanner";
import { DEFAULT_SCAN_CONFIG } from "@/lib/polymarket/config";
import { enforceRateLimit } from "@/lib/rateLimit";
import type { ScanTagFilters } from "@/lib/types";

export const runtime = "nodejs";

function normalizeTagArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => String(tag).trim())
    .filter((tag) => tag.length > 0)
    .slice(0, 100);
}

async function readScanTagFilters(request: NextRequest): Promise<ScanTagFilters> {
  try {
    const body = await request.json();
    return {
      tags: normalizeTagArray(body?.tags),
      excludedTags: normalizeTagArray(body?.excludedTags),
    };
  } catch {
    return {};
  }
}

/**
 * POST /api/scan — Trigger a new scan and persist results.
 */
export async function POST(request: NextRequest) {
  const limited = enforceRateLimit(request, "scan", 3, 60_000);
  if (limited) return limited;

  try {
    const tagFilters = await readScanTagFilters(request);
    const result = await runScan(DEFAULT_SCAN_CONFIG, tagFilters);
    persistScanResult(result.scan, result.opportunities);

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
 * Query params: ?decision=actionable&maxDays=10
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const scan = getLatestScanRun();

  if (!scan) {
    return Response.json(
      { error: "No scan results found. Run a scan first." },
      { status: 404 }
    );
  }

  const decision = searchParams.get("decision");
  // Note: minYield filtering lives on the client because yield is recomputed
  // at the user's trade size. The DB-stored annualized_yield_pct is the
  // $200 baseline and would filter against a different metric than what
  // the user sees.
  const maxDaysRaw = searchParams.get("maxDays");
  const maxDays = maxDaysRaw == null ? undefined : Number(maxDaysRaw);

  const opportunities = listOpportunitiesForScan(scan.scanId, {
    decision: decision ?? undefined,
    maxDays,
  });

  return Response.json({ scan, opportunities });
}
