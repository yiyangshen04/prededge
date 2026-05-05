import type {
  GammaMarket,
  TailCandidate,
  Opportunity,
  ScanRun,
  ScanResponse,
  ScanConfig,
  ScanTagFilters,
} from "../types";
import { PolymarketClient } from "./client";
import {
  analyzeOrderBook,
  computeNetReturn,
  estimateHoldingDays,
  computeAnnualizedYield,
  computeStabilityScore,
  decideCandidate,
  daysToExpiry,
} from "./scoring";
import { inferMarketTiming } from "./timing";
import { inspectOracleResolutionStates } from "./oracleState";

// ── Helpers ──

function parseJsonArray(raw: string | string[] | undefined | null): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function deriveEventSlug(market: GammaMarket): string {
  if (market.eventSlug) return market.eventSlug;
  if (market.events?.length) {
    return market.events[0].slug ?? "";
  }
  return "";
}

function deriveEventTitle(market: GammaMarket): string | null {
  // Use the first event's title — Polymarket's UI shows this as the page
  // header when the user deep-links to /event/{eventSlug}/{marketSlug}.
  // Null if the market isn't grouped under an event (rare; most markets
  // belong to exactly one event).
  const title = market.events?.[0]?.title;
  return typeof title === "string" && title.length > 0 ? title : null;
}

function toFloat(val: unknown, fallback = 0): number {
  if (val == null) return fallback;
  const n = typeof val === "number" ? val : parseFloat(String(val));
  return isNaN(n) ? fallback : n;
}

function hasUmaResolutionStatus(
  status: string | null | undefined
): status is string {
  const normalized = status?.trim();
  return (
    normalized != null &&
    normalized.length > 0 &&
    normalized.toLowerCase() !== "none"
  );
}

function normalizeUmaResolutionStatus(market: GammaMarket): string | null {
  const direct = market.umaResolutionStatus?.trim();
  if (hasUmaResolutionStatus(direct)) return direct;

  const statuses = parseJsonArray(market.umaResolutionStatuses);
  return statuses.map((status) => status.trim()).find(hasUmaResolutionStatus) ?? null;
}

function isOracleResolutionCandidate(candidate: TailCandidate): boolean {
  return hasUmaResolutionStatus(candidate.umaResolutionStatus);
}

function normalizeTagLabel(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizeTagFilters(filters?: ScanTagFilters): {
  included: Set<string>;
  excluded: Set<string>;
} {
  const included = new Set(
    (filters?.tags ?? [])
      .map(normalizeTagLabel)
      .filter((tag) => tag.length > 0)
  );
  const excluded = new Set(
    (filters?.excludedTags ?? [])
      .map(normalizeTagLabel)
      .filter((tag) => tag.length > 0)
  );

  return { included, excluded };
}

function hasTagFilters(filters: { included: Set<string>; excluded: Set<string> }) {
  return filters.included.size > 0 || filters.excluded.size > 0;
}

function candidateMatchesScanTag(candidate: TailCandidate, tag: string): boolean {
  // Match the dashboard's synthetic Sports behavior: some sports markets carry
  // a `sportsMarketType` even when event tags arrive late or are incomplete.
  if (tag === "sports" && candidate.sportsMarketType != null) return true;
  return candidate.tags.some((candidateTag) => normalizeTagLabel(candidateTag) === tag);
}

function candidatePassesTagFilters(
  candidate: TailCandidate,
  filters: { included: Set<string>; excluded: Set<string> }
): boolean {
  if (
    filters.included.size > 0 &&
    ![...filters.included].some((tag) => candidateMatchesScanTag(candidate, tag))
  ) {
    return false;
  }

  return ![...filters.excluded].some((tag) =>
    candidateMatchesScanTag(candidate, tag)
  );
}

function oracleInspectionKey(input: {
  resolvedBy?: string | null;
  questionID?: string | null;
}): string | null {
  if (!input.resolvedBy || !input.questionID) return null;
  return `${input.resolvedBy.toLowerCase()}:${input.questionID}`;
}

/**
 * Max candidates to fetch order books for (controls scan speed).
 * At concurrency=15 and ~200ms/request, 300 tokens adds ~4s on top of the
 * base scan — acceptable for a 30-60s scan budget. Raise carefully: CLOB
 * has no advertised rate limit and 429s start to appear around ~500.
 */
const MAX_BOOK_FETCHES = 300;

/**
 * Extra CLOB book slots reserved for markets already in UMA proposal/dispute
 * flow. These can rank poorly on normal yield heuristics because the event
 * date is stale or volume is thin, but they are exactly the "settlement tail"
 * class users want to audit separately.
 */
const MAX_ORACLE_BOOK_FETCHES = 80;

/**
 * Minimum outcome price for an `endDate < now` market to count as truly
 * awaiting resolution. Polymarket's Gamma API has systematic `endDate`
 * staleness on recurring markets (e.g. the monthly "Trump declassifies UFO
 * files" series rolls the question forward to April 30 but leaves the
 * endDate field on the old March 31 value). Requiring the price to have
 * already converged to the tail extreme filters out these stale rows and
 * the "event just starting" edge case, leaving only markets whose real-
 * world outcome is effectively known and are just waiting on UMA oracle.
 */
const AWAITING_PRICE_CONVERGED = 0.97;

// ── Scanner ──

/**
 * Run a full tail-sweeping scan.
 *
 * Optimized pipeline:
 *   1. Fetch all active markets from Gamma API
 *   2. Filter for tail prices using Gamma's outcomePrices (no CLOB calls needed)
 *   3. Apply scan-time tag preferences, when provided
 *   4. Pre-score using Gamma data to pick top candidates
 *   5. Fetch order books ONLY for top candidates
 *   6. Final score and classify
 *   7. Deduplicate by event, rank, and return
 */
export async function runScan(
  config: ScanConfig,
  tagFilters?: ScanTagFilters
): Promise<ScanResponse> {
  const startTime = Date.now();
  const scanId = `scan_${startTime}`;
  const client = new PolymarketClient(config);
  const normalizedTagFilters = normalizeTagFilters(tagFilters);

  // ── Stage 1: Fetch all active markets ──
  console.log("[scan] Stage 1: Fetching markets from Gamma API...");
  const markets = await client.fetchAllMarkets();
  console.log(`[scan] Fetched ${markets.length} markets`);

  // ── Stage 2: Filter for tail candidates using Gamma outcomePrices ──
  console.log("[scan] Stage 2: Filtering tail candidates...");
  let candidates: TailCandidate[] = [];

  for (const market of markets) {
    // Strict filters (Gamma can return markets whose `active=true&closed=false`
    // predicate was stale when we queried, or whose UI-facing state has since
    // shifted). Any market failing these is definitely not tradeable.
    if (market.closed === true) continue;
    if (market.active !== true) continue;
    if (market.acceptingOrders !== true) continue;
    if (market.archived === true) continue;
    if (market.enableOrderBook === false) continue;

    // Keep markets already in UMA oracle resolution flow visible, but classify
    // them separately downstream. Observed statuses from Gamma:
    // 'proposed' (proposal submitted), 'disputed' (proposal contested).
    // These are not normal "awaiting resolution" tail windows because the
    // oracle process itself is already in flight.
    // Infer trusted timing before filtering/scoring. Gamma `endDate` is often
    // stale on recurring or rescheduled markets, so the rest of the scanner
    // uses eventDeadline/expectedPayoutDate instead of trusting the raw field.
    const timing = inferMarketTiming(market, startTime);

    const tokenIds = parseJsonArray(market.clobTokenIds);
    const outcomes = parseJsonArray(market.outcomes);
    const prices = parseJsonArray(market.outcomePrices);

    if (tokenIds.length === 0 || prices.length === 0) continue;

    const eventSlug = deriveEventSlug(market);
    const eventTitle = deriveEventTitle(market);
    const vol = toFloat(market.volume24hr ?? market.volume);
    const liq = toFloat(market.liquidityClob ?? market.liquidity);
    const rewardsIncentivized = toFloat(market.rewardsMinSize, 0) > 0;
    const negRisk = market.negRisk === true;
    const umaResolutionStatus = normalizeUmaResolutionStatus(market);
    const sportsMarketType = market.sportsMarketType ?? null;
    const gameStartTime = market.gameStartTime ?? null;

    // Hard-skip sports markets whose kickoff is imminent (<15 min future).
    // Per Polymarket's official docs, sports markets have all outstanding
    // limit orders automatically cancelled "at the official start time" —
    // so any ask depth we'd snapshot here is about to evaporate. This
    // cancel-at-kickoff mechanism is explicitly scoped to sports in the
    // docs; non-sports markets with a `gameStartTime` field (weather
    // buckets, short-window Elon tweets, political milestones) don't have a
    // documented book-clear, so we don't hard-skip them here — their
    // in-play / window-open price drift is handled by the downstream
    // decideCandidate demotion, not by hard filtering.
    // https://help.polymarket.com/en/articles/13364444-limit-orders
    if (gameStartTime && sportsMarketType) {
      const kickoffMs = new Date(gameStartTime).getTime();
      if (!isNaN(kickoffMs)) {
        const minsToKickoff = (kickoffMs - Date.now()) / 60_000;
        if (minsToKickoff > 0 && minsToKickoff < 15) continue;
      }
    }

    // Build outcome → tokenId map (for both sides, used by trading UI)
    const outcomeTokens: Record<string, string> = {};
    for (let i = 0; i < tokenIds.length; i++) {
      const outcomeName = outcomes[i] ?? `Outcome ${i + 1}`;
      outcomeTokens[outcomeName] = tokenIds[i];
    }

    for (let i = 0; i < tokenIds.length; i++) {
      const price = parseFloat(prices[i] ?? "0");
      if (isNaN(price)) continue;

      // High-tail only: we sweep near-certain YES (>= 0.93). Low-tail YES
      // (<= 0.05) is a longshot lottery ticket, not a sweep — on binary
      // markets the equivalent "safe" play is the sibling NO token at 0.95+,
      // which is already covered by the high-tail branch.
      if (price < config.tailPriceMin || price > config.tailPriceMax) continue;

      candidates.push({
        conditionId: market.conditionId,
        question: market.question,
        slug: market.slug,
        eventSlug,
        eventTitle,
        endDate: market.endDate,
        eventDeadline: timing.eventDeadline,
        resolutionDeadline: timing.resolutionDeadline,
        expectedPayoutDate: timing.expectedPayoutDate,
        tags: [],
        tokenId: tokenIds[i],
        outcome: outcomes[i] ?? `Outcome ${i + 1}`,
        gammaPrice: price,
        clobBuyPrice: null,
        volume24hr: vol,
        liquidity: liq,
        description: market.description ?? "",
        outcomeTokens,
        awaitingResolution: timing.awaitingResolution,
        staleRawEndDate: timing.staleRawEndDate,
        recurrentLike: timing.recurrentLike,
        postponed: timing.postponed,
        timingConfidence: timing.confidence,
        timingReasons: timing.reasons,
        rewardsIncentivized,
        negRisk,
        umaResolutionStatus,
        resolvedBy: market.resolvedBy ?? null,
        questionID: market.questionID ?? null,
        sportsMarketType,
        gameStartTime: gameStartTime ?? undefined,
      });
    }
  }
  console.log(`[scan] Found ${candidates.length} tail candidates`);

  const prefetchedCandidateTags = hasTagFilters(normalizedTagFilters);
  if (prefetchedCandidateTags && candidates.length > 0) {
    const eventSlugs = [
      ...new Set(candidates.map((c) => c.eventSlug).filter(Boolean)),
    ];
    console.log(
      `[scan] Stage 2a: Fetching tags for ${eventSlugs.length} candidate events...`
    );
    const tagMap = await client.fetchEventTagsBatch(eventSlugs);
    for (const candidate of candidates) {
      const eventTags = tagMap.get(candidate.eventSlug) ?? [];
      candidate.tags = eventTags.map((t) => t.label);
    }

    const beforeTagFilter = candidates.length;
    candidates = candidates.filter((candidate) =>
      candidatePassesTagFilters(candidate, normalizedTagFilters)
    );
    console.log(
      `[scan] Tag filters kept ${candidates.length}/${beforeTagFilter} tail candidates`
    );
  }

  if (candidates.length === 0) {
    return buildEmptyResponse(scanId, markets.length, startTime);
  }

  // ── Stage 3: Pre-score and select top candidates for book fetching ──
  // Heuristic: annualized-ish score = (1 - price) / holdDays × log10(volume)
  // Including holdDays is critical — a 0.98 market expiring tomorrow has
  // ~730% annualized yield vs ~4% for the same price a year out. Without
  // this, short-term gems get pushed past MAX_BOOK_FETCHES and silently lost.
  console.log("[scan] Stage 3: Pre-scoring and selecting top candidates...");

  candidates.sort((a, b) => {
    const holdA = Math.max(
      estimateHoldingDays(a.expectedPayoutDate ?? a.eventDeadline ?? a.endDate),
      1
    );
    const holdB = Math.max(
      estimateHoldingDays(b.expectedPayoutDate ?? b.eventDeadline ?? b.endDate),
      1
    );
    const retA = 1.0 - a.gammaPrice;
    const retB = 1.0 - b.gammaPrice;
    const scoreA =
      (retA / holdA) * Math.log10(Math.max(a.volume24hr, 1) + 1);
    const scoreB =
      (retB / holdB) * Math.log10(Math.max(b.volume24hr, 1) + 1);
    return scoreB - scoreA;
  });

  const baseCandidates = candidates.slice(0, MAX_BOOK_FETCHES);
  const oracleCandidates = candidates
    .filter(isOracleResolutionCandidate)
    .slice(0, MAX_ORACLE_BOOK_FETCHES);
  const byTokenId = new Map<string, TailCandidate>();
  for (const candidate of [...baseCandidates, ...oracleCandidates]) {
    byTokenId.set(candidate.tokenId, candidate);
  }
  const topCandidates = [...byTokenId.values()];
  const droppedCount = candidates.length - topCandidates.length;
  const oracleAddedCount = topCandidates.length - baseCandidates.length;
  console.log(
    `[scan] Selected top ${topCandidates.length} for depth analysis (${baseCandidates.length} base + ${oracleAddedCount} oracle-status, pre-sort dropped ${droppedCount})`
  );

  // ── Stage 4: Fetch order books for top candidates ──
  console.log("[scan] Stage 4: Fetching order books...");
  const bookTokenIds = topCandidates.map((c) => c.tokenId);
  const bookMap = await client.fetchBooksBatch(bookTokenIds);
  console.log(`[scan] Fetched ${bookMap.size} order books`);

  // ── Stage 5: Score and classify ──
  // All calculations use the REAL best ask price from the order book, not Gamma's reference price
  console.log("[scan] Stage 5: Scoring candidates (using order book prices)...");
  const opportunities: Opportunity[] = [];

  for (const c of topCandidates) {
    const book = bookMap.get(c.tokenId);
    if (!book) continue;

    const analysis = analyzeOrderBook(book, config);

    // Skip if no asks on the book at all
    if (analysis.bestAskPrice == null) continue;

    const realPrice = analysis.bestAskPrice;

    // Re-check: is the real ask price still in the tail zone?
    if (realPrice < config.tailPriceMin || realPrice > config.tailPriceMax) continue;

    const nearDepthUsd = analysis.nearDepthUsd;
    const slippageBps = analysis.slippageBps;

    const netReturnPct = computeNetReturn(realPrice, slippageBps, config);
    const eventDeadline = c.eventDeadline ?? c.endDate;
    const resolutionDeadline = c.resolutionDeadline ?? null;
    const expectedPayoutDate =
      c.expectedPayoutDate ?? eventDeadline ?? c.endDate;
    const holdDays = estimateHoldingDays(expectedPayoutDate);
    const annualizedYield = computeAnnualizedYield(netReturnPct, holdDays);
    const days = daysToExpiry(eventDeadline);

    const stabilityScore = computeStabilityScore(
      netReturnPct,
      nearDepthUsd,
      slippageBps,
      holdDays,
      c.volume24hr,
      config
    );

    const { decision, reasons } = decideCandidate(
      netReturnPct,
      nearDepthUsd,
      slippageBps,
      holdDays,
      c.volume24hr,
      config,
      {
        rewardsIncentivized: c.rewardsIncentivized,
        umaResolutionStatus: c.umaResolutionStatus,
        negRisk: c.negRisk,
        sportsMarketType: c.sportsMarketType,
        inPlayGameStartedAt: c.gameStartTime ?? null,
        timingConfidence: c.timingConfidence,
        resolutionWindow: resolutionDeadline != null,
        postponed: c.postponed,
      }
    );

    // Piggy-back the parsed deadline onto decision_reasons as a persistence
    // compatibility channel. Prefix ensures no collision with judgment
    // reasons; UI strips this entry before rendering the reasons strip.
    if (resolutionDeadline) {
      reasons.push(`deadline:${resolutionDeadline}`);
    }

    // Snapshot top 20 ask levels (price asc) within the tail zone so the
    // frontend can re-walk the book at any user-chosen trade size.
    const topAsks = (book.asks ?? [])
      .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .filter(
        (a) =>
          a.price > 0 &&
          a.size > 0 &&
          a.price <= config.tailPriceMax
      )
      .sort((a, b) => a.price - b.price)
      .slice(0, 20);

    opportunities.push({
      conditionId: c.conditionId,
      tokenId: c.tokenId,
      question: c.question,
      eventSlug: c.eventSlug,
      eventTitle: c.eventTitle,
      outcome: c.outcome,
      side: "BUY",
      price: realPrice,
      annualizedYieldPct: Math.round(annualizedYield * 10000) / 100,
      netReturnPct: Math.round(netReturnPct * 10000) / 10000,
      daysToExpiry: Math.round(days * 10) / 10,
      nearDepthUsd,
      slippageBps,
      stabilityScore,
      decision,
      decisionReasons: reasons,
      volume24hr: Math.round(c.volume24hr * 100) / 100,
      liquidity: Math.round(c.liquidity * 100) / 100,
      marketUrl: c.eventSlug
        ? `https://polymarket.com/event/${c.eventSlug}/${c.slug}`
        : `https://polymarket.com/market/${c.slug}`,
      endDate: c.endDate,
      eventDeadline,
      tags: c.tags,
      outcomeTokens: c.outcomeTokens,
      asks: topAsks,
      // Only flag awaiting-resolution once the real book price has
      // converged to the tail extreme — see AWAITING_PRICE_CONVERGED.
      awaitingResolution:
        c.awaitingResolution === true &&
        !hasUmaResolutionStatus(c.umaResolutionStatus) &&
        (realPrice >= AWAITING_PRICE_CONVERGED ||
          realPrice <= 1 - AWAITING_PRICE_CONVERGED),
      rewardsIncentivized: c.rewardsIncentivized,
      negRisk: c.negRisk,
      umaResolutionStatus: c.umaResolutionStatus ?? null,
      resolvedBy: c.resolvedBy ?? null,
      questionID: c.questionID ?? null,
      resolutionDeadline,
      expectedPayoutDate,
      staleRawEndDate: c.staleRawEndDate,
      recurrentLike: c.recurrentLike,
      postponed: c.postponed,
      timingConfidence: c.timingConfidence,
      timingReasons: c.timingReasons ?? [],
      sportsMarketType: c.sportsMarketType ?? null,
      gameStartTime: c.gameStartTime ?? null,
    });
  }

  // ── Stage 5a: Refine UMA oracle-flow markets with on-chain Adapter state ──
  const oracleOpps = opportunities.filter(
    (o) => hasUmaResolutionStatus(o.umaResolutionStatus) && o.resolvedBy && o.questionID
  );
  if (oracleOpps.length > 0) {
    console.log(
      `[scan] Stage 5a: Inspecting on-chain UMA state for ${oracleOpps.length} oracle opportunities...`
    );
    const stateMap = await inspectOracleResolutionStates(
      oracleOpps,
      Math.min(config.concurrency, 4)
    );
    for (const opp of oracleOpps) {
      const key = oracleInspectionKey(opp);
      const inspected = key ? stateMap.get(key) : null;
      if (!inspected) continue;
      opp.oracleResolutionState = inspected.state;
      opp.oracleResolutionDetails = inspected.details;
      if (
        inspected.state === "reset_stalled" &&
        !opp.decisionReasons.includes("oracle_reset_stalled")
      ) {
        opp.decisionReasons.push("oracle_reset_stalled");
      }
      if (
        inspected.state === "second_dispute" &&
        !opp.decisionReasons.includes("oracle_second_dispute")
      ) {
        opp.decisionReasons.push("oracle_second_dispute");
      }
    }
    console.log(`[scan] Inspected ${stateMap.size} oracle adapter states`);
  }

  // ── Stage 5b: Fetch event tags for scored opportunities ──
  if (prefetchedCandidateTags) {
    console.log("[scan] Stage 5b: Reusing candidate tags");
  } else {
    const eventSlugs = [
      ...new Set(opportunities.map((o) => o.eventSlug).filter(Boolean)),
    ];
    console.log(`[scan] Stage 5b: Fetching tags for ${eventSlugs.length} events...`);
    const tagMap = await client.fetchEventTagsBatch(eventSlugs);

    for (const opp of opportunities) {
      const eventTags = tagMap.get(opp.eventSlug) ?? [];
      opp.tags = eventTags.map((t) => t.label);
    }
    console.log(`[scan] Fetched tags for ${tagMap.size} events`);
  }

  // ── Stage 6: Deduplicate by event, sort ──
  console.log("[scan] Stage 6: Deduplicating and ranking...");

  // Group by event; keep top N per event. For negRisk multi-outcome events
  // (e.g. 11-bucket weather or 21-bucket exact-score), N=1 — any additional
  // buckets are mathematical clones that inflate the list without giving the
  // user new information. For binary (Yes/No) events we keep 2 (the tail plus
  // its sibling) so users can see both legs of the same wager.
  const byEvent = new Map<string, Opportunity[]>();
  for (const opp of opportunities) {
    const key = opp.eventSlug || opp.conditionId;
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key)!.push(opp);
  }

  const deduped: Opportunity[] = [];
  for (const [, group] of byEvent) {
    group.sort((a, b) => {
      if (a.decision !== b.decision) {
        const rank = { actionable: 3, observe: 2, rejected: 1 };
        return rank[b.decision] - rank[a.decision];
      }
      return b.stabilityScore - a.stabilityScore;
    });
    const keepN = group.some((g) => g.negRisk === true) ? 1 : 2;
    deduped.push(...group.slice(0, keepN));
  }

  // Final sort: actionable first, then by annualized yield
  deduped.sort((a, b) => {
    const rank = { actionable: 3, observe: 2, rejected: 1 };
    if (rank[a.decision] !== rank[b.decision]) {
      return rank[b.decision] - rank[a.decision];
    }
    return b.annualizedYieldPct - a.annualizedYieldPct;
  });

  const durationMs = Date.now() - startTime;
  const scan: ScanRun = {
    scanId,
    marketsScanned: markets.length,
    candidatesFound: candidates.length,
    actionableCount: deduped.filter((o) => o.decision === "actionable").length,
    observeCount: deduped.filter((o) => o.decision === "observe").length,
    rejectedCount: deduped.filter((o) => o.decision === "rejected").length,
    durationMs,
    startedAt: new Date(startTime).toISOString(),
    completedAt: new Date().toISOString(),
  };

  console.log(
    `[scan] Done in ${durationMs}ms: ${scan.actionableCount} actionable, ${scan.observeCount} observe, ${scan.rejectedCount} rejected`
  );

  return { scan, opportunities: deduped };
}

function buildEmptyResponse(
  scanId: string,
  marketsScanned: number,
  startTime: number
): ScanResponse {
  return {
    scan: {
      scanId,
      marketsScanned,
      candidatesFound: 0,
      actionableCount: 0,
      observeCount: 0,
      rejectedCount: 0,
      durationMs: Date.now() - startTime,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
    },
    opportunities: [],
  };
}
