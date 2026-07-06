import { NextRequest } from "next/server";
import { listOpenPaperTrades, updatePaperTradeResolution } from "@/lib/localDb";
import { PolymarketClient } from "@/lib/polymarket/client";
import { DEFAULT_SCAN_CONFIG } from "@/lib/polymarket/config";
import { takerFeePct } from "@/lib/polymarket/scoring";
import { takerFeeRateOf } from "@/lib/polymarket/scanner";
import { enforceRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

function parseJsonArray(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * POST /api/trades/refresh
 * Sweeps all open paper trades, checks Gamma for resolution, updates status and pnl.
 */
export async function POST(request: NextRequest) {
  const limited = enforceRateLimit(request, "refresh", 10, 60_000);
  if (limited) return limited;

  try {
    const openTrades = listOpenPaperTrades();
    if (openTrades.length === 0) {
      return Response.json({
        checked: 0,
        resolved: 0,
        message: "No open trades.",
      });
    }

    // 2. Look up markets by conditionId
    const conditionIds = Array.from(
      new Set(openTrades.map((t) => t.conditionId).filter(Boolean))
    );

    const client = new PolymarketClient(DEFAULT_SCAN_CONFIG);
    const marketMap = await client.fetchMarketsByConditionIds(conditionIds);

    type UpdateResult = { ok: boolean; id: string; error?: unknown };
    const updates: UpdateResult[] = [];

    // 3. For each open trade, decide its fate
    for (const trade of openTrades) {
      const market = marketMap.get(trade.conditionId);
      if (!market) continue;
      if (!market.closed) continue;

      const outcomes = parseJsonArray(market.outcomes);
      const prices = parseJsonArray(market.outcomePrices);

      // Find the winning outcome: the one whose price is 1.0 (or very close)
      let winnerIdx = -1;
      for (let i = 0; i < prices.length; i++) {
        const p = parseFloat(prices[i]);
        if (!isNaN(p) && p >= 0.99) {
          winnerIdx = i;
          break;
        }
      }

      if (winnerIdx === -1) {
        // `closed: true` means the market has exited its active phase and is
        // awaiting UMA oracle resolution — during the 2h challenge window (or
        // 24–48h dispute window) `outcomePrices` hasn't settled yet. Voiding
        // here would be terminal because the next sweep filters on `status
        // = 'open'`, so we'd lose the trade permanently. Skip and retry on
        // the next refresh instead; a genuine void (e.g. UMA ruling "cannot
        // resolve") would need a separate signal, not an absence of one.
        continue;
      }

      let status: "won" | "lost";
      let resolvedOutcome: string | null = null;
      let pnlUsd: number;

      const usdAmount = trade.usdAmount;
      const shares = trade.shares;

      resolvedOutcome = outcomes[winnerIdx] ?? null;
      if (resolvedOutcome === trade.outcomeBought) {
        status = "won";
        // Each share pays $1 on win; deduct fee + transfer cost so this
        // matches TradeModal's pre-trade "P&L if Win" preview. Without
        // this deduction the settled pnl on the Paper Trading page would
        // be higher than what the modal promised at trade time. Fee uses the
        // market's real Fee Structure V2 rate (Gamma feeSchedule is on the
        // market row we already fetched), flat fallback when unknown.
        const avgPrice = shares > 0 ? usdAmount / shares : 0;
        const feeCost =
          usdAmount *
          (takerFeePct(avgPrice, takerFeeRateOf(market), DEFAULT_SCAN_CONFIG) +
            DEFAULT_SCAN_CONFIG.transferCostPct);
        pnlUsd = shares - usdAmount - feeCost;
      } else {
        status = "lost";
        pnlUsd = -usdAmount;
      }

      const pnlPct = usdAmount > 0 ? pnlUsd / usdAmount : 0;

      try {
        const ok = updatePaperTradeResolution(trade.id, {
          status,
          resolvedOutcome,
          pnlUsd,
          pnlPct,
          resolvedAt: new Date().toISOString(),
        });
        updates.push({
          ok,
          id: trade.id,
          error: ok ? undefined : new Error("No local row was updated"),
        });
      } catch (error) {
        updates.push({ ok: false, id: trade.id, error });
      }
    }

    const results = updates;
    const resolvedCount = results.filter((r) => r.ok).length;
    const failedCount = results.length - resolvedCount;
    for (const r of results) {
      if (!r.ok) {
        console.error(
          "[api/trades/refresh] update failed for trade",
          r.id,
          r.error
        );
      }
    }

    return Response.json({
      checked: openTrades.length,
      resolved: resolvedCount,
      failed: failedCount,
    });
  } catch (err) {
    console.error("[api/trades/refresh] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Refresh failed" },
      { status: 500 }
    );
  }
}
