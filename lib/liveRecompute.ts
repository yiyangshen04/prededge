/**
 * Size-sensitive recompute for Opportunity metrics.
 *
 * The scanner stores `annualizedYieldPct` and `slippageBps` at the
 * $200 (minDepthUsd) baseline. Real users trade other sizes — walking the
 * stored ask-book snapshot lets the dashboard rank by the yield they'd
 * actually capture at their chosen size, without another network round-trip.
 *
 * All functions here are pure so they run happily in a client component.
 */

import type { AskLevel, Opportunity } from "./types";
import { DEFAULT_SCAN_CONFIG } from "./polymarket/config";
import {
  computeAnnualizedYield,
  computeNetReturn,
  estimateHoldingDays,
} from "./polymarket/scoring";

/**
 * Resolution-effective end date for holding-day math. Mirrors the scanner's
 * `effectiveEndDate` (scanner.ts) but also honours the `deadline:ISO` entry
 * encoded in `decisionReasons` for rows rehydrated from persistence (where
 * the typed `resolutionDeadline` column may be absent on legacy rows).
 *
 * Both the scanner card's live metrics and the TradeModal's Ann. Yield preview
 * consume this, so PDUFA-style markets (description-parsed deadline strictly
 * later than Gamma endDate) report consistent holding days in both places.
 */
export function effectiveEndDate(opp: Opportunity): string | null {
  const fromReasons = opp.decisionReasons
    ?.find((r) => r.startsWith("deadline:"))
    ?.slice("deadline:".length);
  return (
    opp.expectedPayoutDate ??
    opp.resolutionDeadline ??
    fromReasons ??
    opp.eventDeadline ??
    opp.endDate
  );
}

export interface LiveMetrics {
  /** Average fill price for the chosen tradeSize */
  avgFillPrice: number;
  /** Slippage in bps (= (avg - bestAsk) × 10000, matches scanner convention) */
  slippageBps: number;
  /** Net return as a fraction, post-fee/transferCost */
  netReturnPct: number;
  /** Annualized yield as a percentage number (e.g. 47.3 for 47.3%) */
  annualizedYieldPct: number;
  /** USD actually filled; < tradeSize when book drained */
  investedUsd: number;
  /** USD that couldn't be filled (book too thin) */
  unfilledUsd: number;
  /** True iff the book snapshot can't absorb the full tradeSize */
  bookDrained: boolean;
}

/**
 * Walk the stored ask snapshot to fill `tradeSizeUsd`, returning
 * size-adjusted metrics in the same shape the scanner uses.
 *
 * If the snapshot lacks any asks (legacy rows pre-migration) we fall back
 * to the scanner's stored numbers so nothing breaks visually.
 */
export function recomputeAtSize(
  opp: Opportunity,
  tradeSizeUsd: number
): LiveMetrics {
  const asks: AskLevel[] = Array.isArray(opp.asks) ? opp.asks : [];
  const target = Math.max(tradeSizeUsd, 0);

  if (asks.length === 0 || target <= 0) {
    return {
      avgFillPrice: opp.price,
      slippageBps: opp.slippageBps,
      netReturnPct: opp.netReturnPct,
      annualizedYieldPct: opp.annualizedYieldPct,
      investedUsd: target,
      unfilledUsd: 0,
      bookDrained: false,
    };
  }

  const bestAsk = asks[0].price;
  let cost = 0;
  let shares = 0;
  let remaining = target;

  for (const level of asks) {
    if (remaining <= 0) break;
    const levelCost = level.price * level.size;
    if (remaining >= levelCost) {
      cost += levelCost;
      shares += level.size;
      remaining -= levelCost;
    } else {
      shares += remaining / level.price;
      cost += remaining;
      remaining = 0;
    }
  }

  const filled = target - remaining;
  const bookDrained = remaining > 0.0001;
  const avgFillPrice = shares > 0 ? cost / shares : bestAsk;
  // Same units as scanner.analyzeOrderBook: absolute price points × 10000.
  const slippageBps = Math.max(0, (avgFillPrice - bestAsk) * 10000);

  // Pass `bestAsk` as buyPrice to match scanner.ts:196's invocation — computeNetReturn
  // adds slippage on top of buyPrice internally, so passing avgFillPrice (which
  // already includes the size premium) would double-count slippage.
  // takerFeeRate rides along so the live number stays on the same fee basis as
  // the scanner's stored netReturnPct (rows persisted before the fee-model
  // migration lack the field and fall back to the flat config.feePct).
  const netReturn = computeNetReturn(
    bestAsk,
    slippageBps,
    DEFAULT_SCAN_CONFIG,
    opp.takerFeeRate
  );
  // Mirror scanner.ts: when description parsing found a resolution deadline
  // strictly later than Gamma's endDate, hold days are measured to the
  // deadline, not the event date — otherwise live yield would stay inflated
  // on PDUFA-style markets even after the scanner corrected the baseline.
  const holdDays = estimateHoldingDays(effectiveEndDate(opp));
  const annualized = computeAnnualizedYield(netReturn, holdDays);

  return {
    avgFillPrice,
    slippageBps: Math.round(slippageBps * 100) / 100,
    netReturnPct: Math.round(netReturn * 10000) / 10000,
    annualizedYieldPct: Math.round(annualized * 10000) / 100,
    investedUsd: filled,
    unfilledUsd: remaining,
    bookDrained,
  };
}

/** Rank used for decision-first sort. Higher = earlier in list. */
export const DECISION_RANK: Record<Opportunity["decision"], number> = {
  actionable: 3,
  observe: 2,
  rejected: 1,
};

export type SortKey = "yield" | "score" | "depth" | "expiry";

/**
 * Stable sort: decision tier first (actionable > observe > rejected), then
 * the user's chosen key using the live-recomputed metrics so the order
 * reflects what the user would actually earn at their trade size.
 */
export function sortWithDecisionPriority(
  items: Array<{ opp: Opportunity; live: LiveMetrics }>,
  sortBy: SortKey
): Array<{ opp: Opportunity; live: LiveMetrics }> {
  const sorted = [...items];
  sorted.sort((a, b) => {
    const rankDiff = DECISION_RANK[b.opp.decision] - DECISION_RANK[a.opp.decision];
    if (rankDiff !== 0) return rankDiff;

    // Book-drained items sink within their tier.
    if (a.live.bookDrained !== b.live.bookDrained) {
      return a.live.bookDrained ? 1 : -1;
    }

    switch (sortBy) {
      case "score":
        return b.opp.stabilityScore - a.opp.stabilityScore;
      case "depth":
        return b.opp.nearDepthUsd - a.opp.nearDepthUsd;
      case "expiry":
        return a.opp.daysToExpiry - b.opp.daysToExpiry;
      case "yield":
      default:
        return b.live.annualizedYieldPct - a.live.annualizedYieldPct;
    }
  });
  return sorted;
}
