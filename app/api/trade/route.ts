import { NextRequest } from "next/server";
import { insertPaperTrade } from "@/lib/localDb";
import { PolymarketClient } from "@/lib/polymarket/client";
import { DEFAULT_SCAN_CONFIG } from "@/lib/polymarket/config";
import { fillOrder } from "@/lib/polymarket/fills";
import { enforceRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

/** Guardrail against runaway inserts — paper only, but still worth bounding. */
const MAX_USD_PER_TRADE = 10_000;

/**
 * POST /api/trade
 * Body: {
 *   conditionId, tokenId, question, outcome, marketUrl, endDate, usdAmount
 * }
 * Executes a paper trade: fetches live book, computes fills, persists to paper_trades.
 */
export async function POST(request: NextRequest) {
  const limited = enforceRateLimit(request, "trade", 20, 10_000);
  if (limited) return limited;

  try {
    const body = await request.json();
    const {
      conditionId,
      tokenId,
      question,
      outcome,
      marketUrl,
      endDate,
    } = body;
    const usdAmount = Number(body.usdAmount);

    if (!conditionId || !tokenId || !question || !outcome) {
      return Response.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }
    if (!Number.isFinite(usdAmount) || usdAmount <= 0) {
      return Response.json(
        { error: "usdAmount must be positive" },
        { status: 400 }
      );
    }
    if (usdAmount > MAX_USD_PER_TRADE) {
      return Response.json(
        { error: `usdAmount exceeds max of $${MAX_USD_PER_TRADE}` },
        { status: 400 }
      );
    }

    const client = new PolymarketClient(DEFAULT_SCAN_CONFIG);
    const book = await client.fetchBook(tokenId);

    if (!book || !book.asks || book.asks.length === 0) {
      return Response.json(
        { error: "No asks available on the order book." },
        { status: 400 }
      );
    }

    const fill = fillOrder(book, usdAmount);

    if (fill.shares === 0) {
      return Response.json(
        { error: "Order book is empty or has no valid asks." },
        { status: 400 }
      );
    }

    const trade = insertPaperTrade({
      conditionId,
      tokenId,
      marketQuestion: question,
      outcomeBought: outcome,
      marketUrl: marketUrl ?? null,
      endDate: endDate ?? null,
      usdAmount: usdAmount - fill.remainingUsd, // actual invested
      shares: fill.shares,
      avgFillPrice: fill.avgFillPrice,
      worstFillPrice: fill.worstFillPrice,
      fills: fill.fills,
    });

    return Response.json({ trade, fill });
  } catch (err) {
    console.error("[api/trade] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Trade failed" },
      { status: 500 }
    );
  }
}
