import { NextRequest } from "next/server";
import { PolymarketClient } from "@/lib/polymarket/client";
import { DEFAULT_SCAN_CONFIG } from "@/lib/polymarket/config";
import { fillOrder } from "@/lib/polymarket/fills";

/**
 * POST /api/trade/preview
 * Body: { tokenId: string, usdAmount: number }
 * Returns: FillResult (no DB writes)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const tokenId: string | undefined = body.tokenId;
    const usdAmount: number = Number(body.usdAmount);

    if (!tokenId) {
      return Response.json({ error: "Missing tokenId" }, { status: 400 });
    }
    if (!Number.isFinite(usdAmount) || usdAmount <= 0) {
      return Response.json({ error: "usdAmount must be positive" }, { status: 400 });
    }

    const client = new PolymarketClient(DEFAULT_SCAN_CONFIG);
    const book = await client.fetchBook(tokenId);

    if (!book || !book.asks || book.asks.length === 0) {
      return Response.json(
        { error: "No asks available — no one is selling this outcome right now." },
        { status: 400 }
      );
    }

    const fill = fillOrder(book, usdAmount);

    if (fill.shares === 0) {
      return Response.json(
        { error: "No valid asks on the book." },
        { status: 400 }
      );
    }

    return Response.json({ fill });
  } catch (err) {
    console.error("[api/trade/preview] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Preview failed" },
      { status: 500 }
    );
  }
}
