import { NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase";
import { PolymarketClient } from "@/lib/polymarket/client";
import { DEFAULT_SCAN_CONFIG } from "@/lib/polymarket/config";
import { enforceRateLimit } from "@/lib/rateLimit";

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
    const supabase = createServerSupabaseClient();

    // 1. Fetch open trades
    const { data: openRows, error: fetchError } = await supabase
      .from("paper_trades")
      .select("*")
      .eq("status", "open");

    if (fetchError) {
      return Response.json({ error: fetchError.message }, { status: 500 });
    }

    const openTrades = openRows ?? [];
    if (openTrades.length === 0) {
      return Response.json({
        checked: 0,
        resolved: 0,
        message: "No open trades.",
      });
    }

    // 2. Look up markets by conditionId
    const conditionIds = Array.from(
      new Set(openTrades.map((t) => t.condition_id as string).filter(Boolean))
    );

    const client = new PolymarketClient(DEFAULT_SCAN_CONFIG);
    const marketMap = await client.fetchMarketsByConditionIds(conditionIds);

    let resolvedCount = 0;
    const updates: Array<Promise<unknown>> = [];

    // 3. For each open trade, decide its fate
    for (const trade of openTrades) {
      const market = marketMap.get(trade.condition_id as string);
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

      const usdAmount = Number(trade.usd_amount);
      const shares = Number(trade.shares);

      resolvedOutcome = outcomes[winnerIdx] ?? null;
      if (resolvedOutcome === trade.outcome_bought) {
        status = "won";
        // Each share pays $1 on win; deduct fee + transfer cost so this
        // matches TradeModal's pre-trade "P&L if Win" preview. Without
        // this deduction the settled pnl on the Paper Trading page would
        // be higher than what the modal promised at trade time.
        const feeCost =
          usdAmount *
          (DEFAULT_SCAN_CONFIG.feePct + DEFAULT_SCAN_CONFIG.transferCostPct);
        pnlUsd = shares - usdAmount - feeCost;
      } else {
        status = "lost";
        pnlUsd = -usdAmount;
      }

      const pnlPct = usdAmount > 0 ? pnlUsd / usdAmount : 0;

      updates.push(
        Promise.resolve(
          supabase
            .from("paper_trades")
            .update({
              status,
              resolved_outcome: resolvedOutcome,
              pnl_usd: pnlUsd,
              pnl_pct: pnlPct,
              resolved_at: new Date().toISOString(),
            })
            .eq("id", trade.id)
        )
      );
      resolvedCount++;
    }

    await Promise.all(updates);

    return Response.json({
      checked: openTrades.length,
      resolved: resolvedCount,
    });
  } catch (err) {
    console.error("[api/trades/refresh] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Refresh failed" },
      { status: 500 }
    );
  }
}
