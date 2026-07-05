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
import { adapterQuestionID, inspectOracleResolutionStates } from "./oracleState";
import { sweepDisputeEvents } from "./onchainEvents";
import {
  applyOfficialContextDecision,
  attachOfficialContexts,
  isDirectionalStance,
} from "./officialContext";

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
  // "disputed" wins over the single-value field: after a dispute resets the
  // adapter and officials re-propose, Gamma reports `proposed` in the single
  // field while the statuses history still carries `disputed` — that market
  // IS in dispute flow (the strongest cohort of the dispute-arb research).
  const direct = market.umaResolutionStatus?.trim();
  const statuses = parseJsonArray(market.umaResolutionStatuses).map((s) => s.trim());
  if (
    direct?.toLowerCase() === "disputed" ||
    statuses.some((s) => s.toLowerCase() === "disputed")
  ) {
    return "disputed";
  }
  if (hasUmaResolutionStatus(direct)) return direct;
  return statuses.find(hasUmaResolutionStatus) ?? null;
}

function candidateIsDisputed(candidate: TailCandidate): boolean {
  return candidate.umaResolutionStatus?.trim().toLowerCase() === "disputed";
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
  negRisk?: boolean;
  negRiskRequestID?: string | null;
}): string | null {
  // Must mirror the key construction inside inspectOracleResolutionStates:
  // negRisk markets are keyed by negRiskRequestID, not questionID.
  const qid = adapterQuestionID(input);
  if (!input.resolvedBy || !qid) return null;
  return `${input.resolvedBy.toLowerCase()}:${qid}`;
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
 * class users want to audit separately. Disputed candidates are NOT capped by
 * this — they all get a book fetch (see Stage 3).
 */
const MAX_ORACLE_BOOK_FETCHES = 80;

/**
 * Price window for oracle-in-flight candidates. The Official Ruling class is
 * defined by oracle state + official stance, not by tail price: a disputed
 * market converged to 0.999 or still split at 0.70 is exactly what the
 * dispute-arb research targets, so the normal [0.93, 0.995] window must not
 * cut it. Plain `proposed` markets only collect the leading side (≥ 0.5);
 * DISPUTED markets collect BOTH legs — the trailing leg is the "divergence
 * play" (officials backing the side the market is against), the only
 * high-EV shape in this class. Its actionability is gated downstream on a
 * high-confidence official text stance (see the divergence-leg gate).
 */
const ORACLE_PRICE_MIN = 0.5;
const ORACLE_PRICE_MAX = 0.9999;
const DISPUTED_PRICE_MIN = 0.0001;

/**
 * Disputed markets trade rarely, so their CLOB book snapshots are routinely
 * older than the 60s default staleness cutoff. Dropping them would silently
 * shrink the Official Ruling class, so they get a wider window instead.
 */
const DISPUTED_BOOK_MAX_AGE_MS = 10 * 60_000;

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

  // ── Stage 1b: Coverage backstop — merge the full dispute-flow class ──
  // fetchAllMarkets samples by volume and endDate; a dispute-flow market that
  // is neither high-volume nor near-expiry can fall through both dimensions.
  // Two queries give the full "cohort C" census: currently-disputed (also
  // covers reset-awaiting-reproposal and second disputes) plus re-proposed
  // markets whose history contains a dispute (the ~2h liveness window the
  // disputed query can't see).
  const backstop = await client.fetchDisputeFlowBackstop();
  const knownConditionIds = new Set(
    markets.map((m) => m.conditionId).filter(Boolean)
  );
  let mergedDisputed = 0;
  for (const market of [...backstop.disputed, ...backstop.replay]) {
    if (!market.conditionId || knownConditionIds.has(market.conditionId)) continue;
    knownConditionIds.add(market.conditionId);
    markets.push(market);
    mergedDisputed += 1;
  }
  const disputeCoverage = {
    disputedCount: backstop.disputed.length,
    replayCount: backstop.replay.length,
    complete: backstop.complete,
  };
  console.log(
    `[scan] Stage 1b: dispute-flow backstop ${backstop.disputed.length} disputed + ${backstop.replay.length} re-proposed (${mergedDisputed} new, complete=${backstop.complete})`
  );
  // ── Stage 1c: On-chain event sweep since the previous scan ──
  // QuestionReset/AncillaryDataUpdated are ground truth for the dispute flow;
  // this catches the ~2h re-proposal windows and Gamma indexing lag between
  // two manual refreshes. Failure never blocks the scan.
  let onchainEvents: ScanResponse["onchainEvents"] = null;
  try {
    const knownQids = new Set<string>();
    const extraAdapters: string[] = [];
    for (const m of markets) {
      if (m.questionID) knownQids.add(m.questionID.toLowerCase());
      if (m.negRiskRequestID) knownQids.add(m.negRiskRequestID.toLowerCase());
      if (m.resolvedBy) extraAdapters.push(m.resolvedBy);
    }
    const sweep = await sweepDisputeEvents(client, knownQids, extraAdapters);
    onchainEvents = sweep.summary;
    let mergedFromChain = 0;
    for (const market of sweep.markets) {
      if (!market.conditionId || knownConditionIds.has(market.conditionId)) continue;
      // Only inject still-tradeable rows into the pool; resolved ones remain
      // visible in the event summary.
      if (market.closed === true || market.active !== true) continue;
      knownConditionIds.add(market.conditionId);
      markets.push(market);
      mergedFromChain += 1;
    }
    console.log(
      `[scan] Stage 1c: on-chain sweep blocks ${sweep.summary.fromBlock}-${sweep.summary.toBlock}: ` +
        `${sweep.summary.resetCount} resets, ${sweep.summary.contextUpdateCount} context updates, ` +
        `${sweep.summary.discovered.length} discovered (${mergedFromChain} merged)` +
        (sweep.summary.incomplete ? " [INCOMPLETE]" : "")
    );
  } catch (err) {
    console.warn(
      `[scan] Stage 1c: on-chain sweep unavailable: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Gamma snapshots of disputed markets — the official-context price fallback
  // reads outcomePrices from here when the on-chain text gives no direction.
  const disputedByConditionId = new Map<string, GammaMarket>();

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
    const oracleInFlight = hasUmaResolutionStatus(umaResolutionStatus);
    const sportsMarketType = market.sportsMarketType ?? null;
    const gameStartTime = market.gameStartTime ?? null;

    if (umaResolutionStatus === "disputed" && market.conditionId) {
      disputedByConditionId.set(market.conditionId, market);
    }

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
    // Oracle-in-flight sports markets are exempt: their game is long over and
    // the book that matters is the settlement tail, not the kickoff window.
    if (gameStartTime && sportsMarketType && !oracleInFlight) {
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
      // Oracle-in-flight markets get a wider window: the Official Ruling
      // class is defined by oracle state, not tail price, so converged
      // (>0.995) and still-split (≥0.5) sides must both survive.
      // Disputed markets additionally keep the TRAILING leg (two-leg
      // collection): if officials back the side trading at 0.08, that leg is
      // the actual opportunity and must reach the book/context stages.
      const isDisputedMarket = umaResolutionStatus === "disputed";
      const priceMin = isDisputedMarket
        ? DISPUTED_PRICE_MIN
        : oracleInFlight
          ? ORACLE_PRICE_MIN
          : config.tailPriceMin;
      const priceMax = oracleInFlight ? ORACLE_PRICE_MAX : config.tailPriceMax;
      if (price < priceMin || price > priceMax) continue;

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
        negRiskRequestID: market.negRiskRequestID ?? null,
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
    // Dispute-flow candidates are exempt from tag filters: the Official
    // Ruling class must stay complete even when the user excludes a category
    // (e.g. exclude-Sports would silently drop esports disputes — two real
    // cases on 2026-07-04).
    candidates = candidates.filter(
      (candidate) =>
        isOracleResolutionCandidate(candidate) ||
        candidatePassesTagFilters(candidate, normalizedTagFilters)
    );
    console.log(
      `[scan] Tag filters kept ${candidates.length}/${beforeTagFilter} tail candidates (oracle-flow exempt)`
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

  // Three pools:
  // - disputed: ALL of them, uncapped — the Official Ruling class must not
  //   lose members to a book-fetch quota (they are tens, not hundreds).
  // - other oracle-in-flight (proposed): capped reserve as before.
  // - base: everything else. Oracle candidates are excluded from the base
  //   slice because the widened price window inflates their (1-price) pre-
  //   score and they would crowd real tail candidates out of the top 300.
  const disputedCandidates = candidates.filter(candidateIsDisputed);
  const oracleCandidates = candidates
    .filter((c) => isOracleResolutionCandidate(c) && !candidateIsDisputed(c))
    .slice(0, MAX_ORACLE_BOOK_FETCHES);
  const baseCandidates = candidates
    .filter((c) => !isOracleResolutionCandidate(c))
    .slice(0, MAX_BOOK_FETCHES);
  const byTokenId = new Map<string, TailCandidate>();
  for (const candidate of [...baseCandidates, ...oracleCandidates, ...disputedCandidates]) {
    byTokenId.set(candidate.tokenId, candidate);
  }
  const topCandidates = [...byTokenId.values()];
  const droppedCount = candidates.length - topCandidates.length;
  console.log(
    `[scan] Selected ${topCandidates.length} for depth analysis (${baseCandidates.length} base + ${oracleCandidates.length} oracle-status + ${disputedCandidates.length} disputed, pre-sort dropped ${droppedCount})`
  );

  // ── Stage 4: Fetch order books for top candidates ──
  console.log("[scan] Stage 4: Fetching order books...");
  const disputedTokenIds = new Set(disputedCandidates.map((c) => c.tokenId));
  const normalTokenIds = topCandidates
    .map((c) => c.tokenId)
    .filter((id) => !disputedTokenIds.has(id));
  const [bookMap, disputedBooks] = await Promise.all([
    client.fetchBooksBatch(normalTokenIds),
    client.fetchBooksBatch([...disputedTokenIds], DISPUTED_BOOK_MAX_AGE_MS),
  ]);
  for (const [tokenId, book] of disputedBooks) bookMap.set(tokenId, book);
  console.log(`[scan] Fetched ${bookMap.size} order books`);

  // ── Stage 5: Score and classify ──
  // All calculations use the REAL best ask price from the order book, not Gamma's reference price
  console.log("[scan] Stage 5: Scoring candidates (using order book prices)...");
  const opportunities: Opportunity[] = [];

  // Disputed candidates dropped here must be explainable — the coverage
  // audit ("don't miss any") relies on these counters.
  const disputedDrops = { noBook: 0, noAsks: 0, priceWindow: 0 };

  for (const c of topCandidates) {
    const isDisputed = candidateIsDisputed(c);
    const book = bookMap.get(c.tokenId);
    if (!book) {
      if (isDisputed) disputedDrops.noBook += 1;
      continue;
    }

    // Oracle-in-flight candidates keep their widened price window through
    // book analysis too: with the default config, analyzeOrderBook caps
    // near-depth at tailPriceMax, so a 0.998 disputed ask would read as
    // zero depth and the asks snapshot below would come out empty.
    // Disputed legs keep the two-leg window (trailing leg must survive the
    // best-ask re-check below).
    const oracleInFlight = hasUmaResolutionStatus(c.umaResolutionStatus);
    const effConfig = oracleInFlight
      ? {
          ...config,
          tailPriceMin: isDisputed ? DISPUTED_PRICE_MIN : ORACLE_PRICE_MIN,
          tailPriceMax: ORACLE_PRICE_MAX,
        }
      : config;

    const analysis = analyzeOrderBook(book, effConfig);

    // Skip if no asks on the book at all
    if (analysis.bestAskPrice == null) {
      if (isDisputed) disputedDrops.noAsks += 1;
      continue;
    }

    const realPrice = analysis.bestAskPrice;

    // Re-check: is the real ask price still in the tail zone?
    if (realPrice < effConfig.tailPriceMin || realPrice > effConfig.tailPriceMax) {
      if (isDisputed) disputedDrops.priceWindow += 1;
      continue;
    }

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
          a.price <= effConfig.tailPriceMax
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
      negRiskRequestID: c.negRiskRequestID ?? null,
      resolutionDeadline,
      expectedPayoutDate,
      staleRawEndDate: c.staleRawEndDate,
      recurrentLike: c.recurrentLike,
      postponed: c.postponed,
      timingConfidence: c.timingConfidence,
      timingReasons: c.timingReasons ?? [],
      sportsMarketType: c.sportsMarketType ?? null,
      gameStartTime: c.gameStartTime ?? null,
      // Trailing leg of a disputed market — the divergence-play shape. The
      // definitive gate runs after official context is attached (Stage 5a-2).
      divergenceLeg: isDisputed && realPrice < 0.5,
    });
  }

  if (disputedDrops.noBook + disputedDrops.noAsks + disputedDrops.priceWindow > 0) {
    console.log(
      `[scan] Disputed candidates dropped: ${disputedDrops.noBook} no/stale book, ${disputedDrops.noAsks} no asks, ${disputedDrops.priceWindow} outside price window`
    );
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

  // ── Stage 5a-2: Official additional-context for disputed opportunities ──
  // Reads the on-chain context text (not exposed by Gamma), classifies the
  // implied direction, and integrates it into the decision: the favored side
  // gets `official_direction_backed`, the side the officials ruled against is
  // never actionable, refund-clause markets are never actionable.
  const disputedOpps = opportunities.filter(
    (o) => o.umaResolutionStatus?.trim().toLowerCase() === "disputed"
  );
  if (disputedOpps.length > 0) {
    console.log(
      `[scan] Stage 5a-2: Reading official context for ${disputedOpps.length} disputed opportunities...`
    );
    await attachOfficialContexts(
      disputedOpps,
      disputedByConditionId,
      Math.min(config.concurrency, 4)
    );
    for (const opp of disputedOpps) {
      applyOfficialContextDecision(opp);
    }

    // Divergence-leg gate. A trailing leg's net-return number is conditional
    // on the official direction landing, so the quantitative gates alone must
    // never promote it. Only a high-confidence official TEXT stance aligned
    // with this side (leans_*/price_fallback don't qualify — leans labels ran
    // 3/14 against the market forward, and price fallback always backs the
    // leading side by construction) keeps its quantitative decision.
    for (const opp of disputedOpps) {
      if (opp.divergenceLeg !== true) continue;
      const ctx = opp.officialContext;
      const textBacked =
        ctx != null &&
        ctx.via === "text" &&
        ctx.confidence === "high" &&
        opp.decisionReasons.includes("official_direction_backed");
      if (textBacked) {
        if (!opp.decisionReasons.includes("official_divergence_play")) {
          opp.decisionReasons.push("official_divergence_play");
        }
      } else {
        if (opp.decision === "actionable") opp.decision = "observe";
        if (!opp.decisionReasons.includes("divergence_leg_needs_text_backing")) {
          opp.decisionReasons.push("divergence_leg_needs_text_backing");
        }
      }
    }

    const directional = disputedOpps.filter(
      (o) => o.officialContext != null && isDirectionalStance(o.officialContext.stance)
    ).length;
    const refunds = disputedOpps.filter((o) => o.officialContext?.refundClause).length;
    const divergencePlays = disputedOpps.filter((o) =>
      o.decisionReasons.includes("official_divergence_play")
    ).length;
    console.log(
      `[scan] Official context attached: ${directional} directional, ${refunds} refund-flagged, ${divergencePlays} divergence plays`
    );
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
    const kept = group.slice(0, keepN);
    // Disputed legs always survive event dedup: the Official Ruling census
    // must show every leg of every disputed market (a negRisk sibling bucket
    // with a higher stability score must not evict them), and the divergence
    // pair (leading + trailing leg) only reads as a pair when both are kept.
    for (const opp of group.slice(keepN)) {
      if (opp.umaResolutionStatus?.trim().toLowerCase() === "disputed") {
        kept.push(opp);
      }
    }
    deduped.push(...kept);
  }

  // Official Ruling opportunities survive event dedup unconditionally: in a
  // negRisk event (keepN=1) the officially-backed bucket must not lose its
  // slot to a sibling tail bucket with a higher stability score.
  const keptTokenIds = new Set(deduped.map((o) => o.tokenId));
  for (const opp of opportunities) {
    if (keptTokenIds.has(opp.tokenId)) continue;
    if (
      opp.officialContext != null &&
      isDirectionalStance(opp.officialContext.stance) &&
      opp.decisionReasons.includes("official_direction_backed")
    ) {
      deduped.push(opp);
      keptTokenIds.add(opp.tokenId);
    }
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
    disputeCoverage,
  };

  console.log(
    `[scan] Done in ${durationMs}ms: ${scan.actionableCount} actionable, ${scan.observeCount} observe, ${scan.rejectedCount} rejected`
  );

  return { scan, opportunities: deduped, onchainEvents };
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
