import type { OrderBook, ScanConfig } from "../types";

export interface DepthAnalysis {
  /** Best (lowest) ask price on the order book — the real price you'd pay */
  bestAskPrice: number | null;
  /** Total USD depth within bestAsk + band */
  nearDepthUsd: number;
  /** Slippage in bps: how much VWAP exceeds best ask when filling minDepthUsd */
  slippageBps: number;
  /** VWAP price to fill minDepthUsd worth of orders */
  vwapPrice: number | null;
}

/**
 * Analyze the ask side of the order book.
 * All calculations are based on actual order book prices, NOT Gamma reference prices.
 */
export function analyzeOrderBook(
  book: OrderBook,
  config: ScanConfig
): DepthAnalysis {
  const asks = (book.asks ?? [])
    .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter((a) => a.price > 0 && a.size > 0)
    .sort((a, b) => a.price - b.price);

  if (asks.length === 0) {
    return { bestAskPrice: null, nearDepthUsd: 0, slippageBps: 9999, vwapPrice: null };
  }

  const bestAskPrice = asks[0].price;

  // Near-price depth: sum notional of asks within bestAsk + band
  const nearCap = Math.min(config.tailPriceMax, bestAskPrice + config.nearPriceBand);
  const nearDepthUsd = asks
    .filter((a) => a.price <= nearCap)
    .reduce((sum, a) => sum + a.price * a.size, 0);

  // VWAP and slippage: walk the book to fill minDepthUsd
  const targetNotional = Math.max(config.minDepthUsd, 1);
  let cost = 0;
  let qty = 0;

  for (const ask of asks) {
    const levelNotional = ask.price * ask.size;
    const remaining = targetNotional - cost;
    if (remaining <= 0) break;
    const take = Math.min(levelNotional, remaining);
    cost += take;
    qty += take / ask.price;
  }

  if (cost < targetNotional || qty <= 0) {
    return {
      bestAskPrice,
      nearDepthUsd: Math.round(nearDepthUsd * 100) / 100,
      slippageBps: 9999,
      vwapPrice: null,
    };
  }

  const vwapPrice = cost / qty;
  // Slippage = how much VWAP exceeds the best ask
  const slippageBps = Math.max(0, (vwapPrice - bestAskPrice) * 10000);

  return {
    bestAskPrice,
    nearDepthUsd: Math.round(nearDepthUsd * 100) / 100,
    slippageBps: Math.round(slippageBps * 100) / 100,
    vwapPrice: Math.round(vwapPrice * 10000) / 10000,
  };
}

/**
 * Return on invested capital for buying a YES token at `buyPrice`.
 *
 * For $1 invested you get 1/effectivePrice shares; on a win each share pays
 * $1, so gross ROI is (1 - effectivePrice) / effectivePrice. Fees and
 * transfer costs are a flat fraction of the invested USD, so they subtract
 * directly from the ROI.
 *
 * This matches TradeModal's `pnlIfWin / investedUsd`, so the scanner card's
 * "Net Return" and the trade preview's "Ann. Yield if Win" now reconcile
 * for the same fill price.
 */
export function computeNetReturn(
  buyPrice: number,
  slippageBps: number,
  config: ScanConfig
): number {
  if (buyPrice <= 0) return 0;
  const slippagePct = Math.max(0, slippageBps / 10000);
  const effectivePrice = buyPrice + slippagePct;
  if (effectivePrice <= 0 || effectivePrice >= 1) return 0;
  return (
    (1 - effectivePrice) / effectivePrice - config.feePct - config.transferCostPct
  );
}

/**
 * Estimate days to expiry from an end date string.
 * Returns Infinity if no end date.
 */
export function daysToExpiry(endDate: string | null): number {
  if (!endDate) return Infinity;
  const end = new Date(endDate);
  if (isNaN(end.getTime())) return Infinity;
  const now = new Date();
  const diff = (end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0, diff);
}

/**
 * Estimate how many days you'd hold the position before resolution.
 * For expired markets waiting on settlement: short hold.
 * For future markets: hold until expiry.
 */
export function estimateHoldingDays(endDate: string | null): number {
  const days = daysToExpiry(endDate);
  if (days <= 0) {
    // Already past end date — likely waiting on resolution, estimate 2-5 days
    return 3;
  }
  return Math.max(1, Math.ceil(days));
}

/**
 * Compute annualized yield from net return and holding period.
 */
export function computeAnnualizedYield(
  netReturnPct: number,
  holdingDays: number
): number {
  if (holdingDays <= 0 || netReturnPct <= 0) return 0;
  return (netReturnPct / holdingDays) * 365;
}

/**
 * Stability score 0-100. Starts at 100 and deducts for risk factors.
 */
export function computeStabilityScore(
  netReturnPct: number,
  nearDepthUsd: number,
  slippageBps: number,
  holdingDays: number,
  volume24hr: number,
  config: ScanConfig
): number {
  let score = 100;

  // Net return too low
  if (netReturnPct < config.minNetReturnPct) {
    score -= 35;
  } else if (netReturnPct < config.minNetReturnPct + 0.002) {
    score -= 15;
  }

  // Depth too shallow
  if (nearDepthUsd < config.minDepthUsd) {
    score -= 40;
  } else if (nearDepthUsd < config.minDepthUsd * 2) {
    score -= 18;
  }

  // Slippage penalty (up to -30)
  score -= Math.min(30, slippageBps / 2.5);

  // Long holding period (>30 days)
  if (holdingDays > 30) {
    score -= 20;
  } else if (holdingDays > 14) {
    score -= 10;
  }

  // Low volume
  if (volume24hr < 100) {
    score -= 15;
  } else if (volume24hr < 500) {
    score -= 6;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}

/** Context flags that can demote a candidate below `actionable` regardless
 * of its depth/yield numbers. These describe *why* the top-of-book number
 * is not a real mispricing, even when it passes the quantitative gates. */
export interface CandidateContext {
  /** Gamma `rewardsMinSize > 0` — top of book is bot-maintained. */
  rewardsIncentivized?: boolean;
  /** UMA oracle proposal/dispute in progress. Outcome effectively decided. */
  umaResolutionStatus?: string | null;
  /** Parent market is one of many mutually-exclusive outcomes (Multi-Strikes,
   * Exact Score, Spread tiers). Even when the top ask is real, a ~0.95 ask on
   * one of N buckets is a mathematical tail, not mispriced — so we don't
   * promote it to actionable unless it also survives the other gates. */
  negRisk?: boolean;
  /** Gamma `sportsMarketType`. For non-moneyline sports markets (spreads,
   * totals, child_moneyline) the tail-of-distribution price is a structural
   * artifact, not a mispricing — those names also make the outcome labels
   * look like team-win bets (e.g. "Buy POHANG @ $0.97" in a Gwangju -1.5
   * market reads as "Pohang 97%" while the moneyline is 59%). */
  sportsMarketType?: string | null;
  /** `gameStartTime` (ISO). Meaning varies: sports kickoff, snapshot-window
   * start (weather, short-window Elon tweets, intraday crypto), or a
   * political milestone. When already in the past for sports/snapshot
   * markets the price has entered a high-volatility regime tracking the
   * live data feed, so a pre-scan snapshot drifts within minutes.
   * Imminent-future kickoffs are already hard-skipped by the scanner;
   * here we use this field only to demote already-past markets to observe. */
  inPlayGameStartedAt?: string | null;
  /** Timing inference could not confidently identify the true event cutoff. */
  timingConfidence?: "high" | "medium" | "low";
  /** Market has a later rules deadline after the event window, so payout timing
   * is less immediate than the raw event date suggests. */
  resolutionWindow?: boolean;
  /** Sports/event market where Gamma endDate is the old scheduled date and the
   * event appears postponed or rescheduled. */
  postponed?: boolean;
}

/** Informational tag (not a decision driver). UI reads it to render a badge;
 * persists through the existing `decision_reasons` compatibility channel. */
const INFO_TAGS = new Set(["rewards_incentivized"]);

/**
 * Classify a candidate into actionable / observe / rejected.
 */
export function decideCandidate(
  netReturnPct: number,
  nearDepthUsd: number,
  slippageBps: number,
  holdingDays: number,
  volume24hr: number,
  config: ScanConfig,
  context: CandidateContext = {}
): { decision: "actionable" | "observe" | "rejected"; reasons: string[] } {
  const hardRejects: string[] = [];

  // Hard rejects
  if (nearDepthUsd < config.minDepthUsd) {
    hardRejects.push("insufficient_depth");
  }
  if (netReturnPct < config.minNetReturnPct) {
    hardRejects.push("net_return_below_threshold");
  }
  if (slippageBps > 100) {
    hardRejects.push("excessive_slippage");
  }

  if (hardRejects.length > 0) {
    return {
      decision: "rejected",
      reasons: [...hardRejects, ...informationalTags(context)],
    };
  }

  const softFlags: string[] = [];

  // Soft flags → observe
  if (volume24hr < 100) {
    softFlags.push("low_volume");
  }
  if (holdingDays > 60) {
    softFlags.push("very_long_hold");
  }
  if (slippageBps > 30) {
    softFlags.push("moderate_slippage");
  }
  if (context.timingConfidence === "low") {
    softFlags.push("low_timing_confidence");
  }
  if (context.resolutionWindow) {
    softFlags.push("resolution_deadline_later");
  }
  if (context.postponed) {
    softFlags.push("postponed_or_rescheduled");
  }
  // Context demotion: negRisk multi-outcome market. When the parent market
  // has N mutually-exclusive buckets (Multi-Strikes weather, Exact Score,
  // price brackets), a ~0.95 No on any single bucket is a mathematical tail
  // from the probability distribution, not a discoverable mispricing — the
  // "yield" shown is the EV of a 1/N probability bet, not arbitrage.
  if (context.negRisk) {
    softFlags.push("neg_risk_bucket");
  }
  // Non-moneyline sports markets (spreads, totals, child_moneyline) have
  // structural-tail prices: a -1.5 / -2.5 spread side naturally sits near
  // 0.95+. Demote to observe so users don't mistake the spread ask for a
  // moneyline probability.
  const smt = context.sportsMarketType;
  if (smt && smt !== "moneyline") {
    softFlags.push(`sports_${smt}`);
  }
  // In-play / in-window: gameStartTime already past. Two demotion-worthy
  // cases per the official Polymarket docs and Gamma field inspection:
  //   1. Sports (`sportsMarketType != null`): book was cancelled at kickoff
  //      per docs; whatever depth exists now is freshly-placed in-play
  //      liquidity that moves every score tick.
  //   2. negRisk snapshot markets (Multi-Strikes weather buckets, short-
  //      window tweet counts): the observation window has opened and the
  //      ask now tracks the accumulating real-world data feed.
  // Long-horizon political markets with an unrelated `gameStartTime`
  // milestone (e.g. Venezuela leader end-of-2026, whose `gameStartTime`
  // sits 8 months before endDate) do NOT drift on the same time scale —
  // we leave them alone rather than over-demote.
  const ipTs = context.inPlayGameStartedAt;
  const inPlaySensitive =
    context.sportsMarketType != null || context.negRisk === true;
  if (ipTs && inPlaySensitive) {
    const t = new Date(ipTs).getTime();
    if (!isNaN(t) && t <= Date.now()) {
      softFlags.push("in_play");
    }
  }
  // Oracle in flight: outcome effectively decided. Keep visible for
  // tracking but never actionable.
  const uma = context.umaResolutionStatus?.trim();
  if (uma && uma.toLowerCase() !== "none") {
    softFlags.push(`oracle_${uma.toLowerCase()}`);
  }

  if (softFlags.length > 0) {
    return {
      decision: "observe",
      reasons: [...softFlags, ...informationalTags(context)],
    };
  }

  return { decision: "actionable", reasons: [...informationalTags(context)] };
}

/**
 * Build the list of informational tags for a candidate. These describe the
 * market context (e.g. rewards program) but do not influence the decision —
 * the card shows a badge for each, and the scanner stores them in
 * `decision_reasons` so they survive persistence without needing new columns.
 * The UI filters tags in INFO_TAGS out of the "decision reasons"
 * strip so they don't look like downgrade causes.
 */
function informationalTags(context: CandidateContext): string[] {
  const out: string[] = [];
  if (context.rewardsIncentivized) out.push("rewards_incentivized");
  return out;
}

export { INFO_TAGS };
