// ── Scan configuration ──
export interface ScanConfig {
  /** Min price for tail candidates (buy side, e.g. 0.95) */
  tailPriceMin: number;
  /** Max price for tail candidates (buy side, e.g. 0.995) */
  tailPriceMax: number;
  /** Minimum order-book depth in USD near the buy price */
  minDepthUsd: number;
  /** Minimum net return after fees/slippage to not reject */
  minNetReturnPct: number;
  /** Max markets to fetch from Gamma API */
  maxMarkets: number;
  /** Page size for Gamma API pagination */
  pageLimit: number;
  /** Trading fee as a fraction (e.g. 0.002 = 0.2%) */
  feePct: number;
  /** On-chain transfer cost as a fraction */
  transferCostPct: number;
  /** Band around buy price to measure near-price depth */
  nearPriceBand: number;
  /** Max concurrent CLOB requests */
  concurrency: number;
  /** Request timeout in ms */
  timeoutMs: number;
  /** Number of retries on transient errors */
  retryCount: number;
  /** Base backoff in ms between retries */
  retryBackoffMs: number;
}

// ── Gamma API raw market shape ──
export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  eventSlug?: string;
  endDate: string | null;
  endDateIso?: string;
  /** ISO timestamp the market began trading. For recurring series markets
   * (e.g. monthly "Trump visit China by X?") Polymarket rolls the question
   * forward but leaves `endDate` on the old value, so `startDate > endDate`
   * is a deterministic "this endDate is stale, market is really active"
   * signal. */
  startDate?: string;
  /** ISO timestamp the market row was inserted in Gamma's DB. Same staleness
   * story as startDate — a market cannot legitimately be created after its
   * own endDate. */
  createdAt?: string;
  /** ISO timestamp acceptingOrders last flipped to true. Also useful for
   * stale-endDate detection when startDate/createdAt are absent. */
  acceptingOrdersTimestamp?: string;
  active: boolean;
  closed: boolean;
  acceptingOrders?: boolean;
  /** Some Polymarket markets (e.g. some pre-resolution or feed-driven
   * markets) disable the CLOB order book even while `active=true`. A `false`
   * here means the user cannot place limit/market orders via the CLOB. */
  enableOrderBook?: boolean;
  /** True when the market has been archived by Polymarket ops. Archived
   * markets don't show up in the normal UI even if `active=true`. */
  archived?: boolean;
  /** Minimum USD size a maker must quote to qualify for the liquidity-rewards
   * program on this market. When > 0 the top of the book is typically a
   * rewards-incentivized bot, not a mispricing — we don't want to surface
   * those as `actionable`. */
  rewardsMinSize?: number;
  /** Maximum spread (in cents × 100, i.e. bps) a maker can quote and still
   * earn rewards. Shown alongside rewardsMinSize for context. */
  rewardsMaxSpread?: number;
  /** True for "one of many mutually-exclusive outcomes" markets (e.g. each
   * temperature bucket in a Multi-Strikes weather event). We collapse them
   * to one opportunity per event so a single 11-bucket market doesn't
   * produce 11 near-identical actionables. */
  negRisk?: boolean;
  /** UMA oracle resolution state. `null`/missing = not yet in resolution
   * flow; `'proposed'` / `'disputed'` = oracle proposal submitted and under
   * dispute window. In those states the price has almost always converged
   * and the "yield" is illusory — we exclude these from actionable. */
  umaResolutionStatus?: string | null;
  /** For sports markets: 'moneyline' (winner picks), 'spreads' (point-spread
   * wagers), 'totals' (over/under), 'child_moneyline', etc. Non-moneyline
   * sports markets have tail-of-distribution prices that look like
   * mispricings but are really structural (a -2.5 spread side is naturally
   * ~0.95+). We treat these like negRisk and demote from actionable. */
  sportsMarketType?: string | null;
  /** ISO "event start" time. Meaning varies by market type:
   * - Sports: kickoff / first pitch (= endDate for most sports markets)
   * - Snapshot markets (weather, short-window Elon tweet count, intraday
   *   crypto): *start* of the observation window — the moment real-world
   *   data begins accumulating and the price starts tracking it
   * - Political / long-horizon markets: an internal milestone field, not a
   *   discrete book-state change
   *
   * What this field is NOT: a "book clears here" signal. `clearBookOnStart`
   * is ~99% default-true across Gamma and almost certainly an activation-
   * time initializer, not runtime cycling.
   *
   * Why the scanner still uses it: once `gameStartTime` is in the past for
   * a sports/snapshot market, the price enters a high-volatility regime
   * (in-play scoring, accumulating tweet counts, temp readings rolling in),
   * so our scan snapshot goes stale within minutes. Scanner hard-skips
   * markets where this is < 15 min in the future (approaching that regime)
   * and demotes markets where it's already past. */
  gameStartTime?: string | null;
  /** JSON-encoded string: e.g. '["Yes","No"]' */
  outcomes: string;
  /** JSON-encoded string: e.g. '["0.95","0.05"]' */
  outcomePrices: string;
  /** JSON-encoded string of token IDs */
  clobTokenIds: string;
  volume: string;
  volume24hr?: number;
  liquidity: string;
  liquidityClob?: number;
  lastTradePrice?: number;
  bestBid?: number;
  bestAsk?: number;
  description?: string;
  resolutionSource?: string;
  image?: string;
  events?: Array<{ slug: string; title: string; id: string }>;
}

// ── CLOB API order book ──
export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  timestamp: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

// ── CLOB API price response ──
export interface ClobPriceResponse {
  price: string;
}

// ── Parsed token from a Gamma market ──
export interface ParsedToken {
  tokenId: string;
  outcome: string;
  price: number;
}

// ── Intermediate candidate after initial filtering ──
export interface TailCandidate {
  conditionId: string;
  question: string;
  slug: string;
  eventSlug: string;
  /** Human-readable title of the parent event (e.g. "SpaceX Starship Flight
   * Test 12"). The card shows it as a subtitle so users expect the event
   * hub page when they click through, rather than thinking the deep link
   * is broken. */
  eventTitle: string | null;
  endDate: string | null;
  tokenId: string;
  outcome: string;
  /** Price from Gamma outcomePrices */
  gammaPrice: number;
  /** Precise price from CLOB /price (filled in Stage 3) */
  clobBuyPrice: number | null;
  volume24hr: number;
  liquidity: number;
  description: string;
  /** All outcomes to token IDs for this market (e.g. {"Yes":"0x..","No":"0x.."}) */
  outcomeTokens: Record<string, string>;
  /** True when endDate has passed but the market is still accepting orders
   * (the "arbitrageur lag" window — real-world outcome known, on-chain price
   * hasn't converged yet). */
  awaitingResolution?: boolean;
  /** True when the parent market has a liquidity-rewards program
   * (rewardsMinSize > 0). These are usually dominated by maker bots; we
   * demote them out of `actionable` since the top of book isn't a mispricing. */
  rewardsIncentivized?: boolean;
  /** True for negRisk Multi-Strikes markets (e.g. one temperature bucket
   * within an 11-bucket weather event). Used for event-level dedup. */
  negRisk?: boolean;
  /** Whenever the UMA oracle has a proposal submitted for this market — at
   * that point the outcome is effectively decided, so the ask-side "yield"
   * is illusory. */
  umaResolutionStatus?: string | null;
  /** Gamma `sportsMarketType`. Used to demote non-moneyline sports markets
   * (spreads/totals) that have structural-tail prices rather than mispricings. */
  sportsMarketType?: string | null;
  /** ISO kickoff time. Polymarket clears the book when the clock hits this
   * moment (`clearBookOnStart=true` is the default for ~99% of markets, so
   * the telltale is whether a discrete clear-time field is populated).
   * - Future < 15 min: current asks will be cancelled; snapshot depth
   *   becomes zero imminently → hard-skip.
   * - Past: market is in-play; prices move second-to-second and any scan
   *   snapshot is stale within minutes → demote to observe. */
  gameStartTime?: string;
}

// ── Event tag from Gamma API ──
export interface EventTag {
  id: string;
  label: string;
  slug: string;
}

/** Truncated ask-side snapshot used by the frontend to recompute size-dependent
 * slippage and yield without hitting the CLOB again. */
export interface AskLevel {
  price: number;
  size: number;
}

// ── Scored opportunity ready for display/storage ──
export interface Opportunity {
  conditionId: string;
  tokenId: string;
  question: string;
  eventSlug: string;
  /** Human-readable title of the parent event on Polymarket (see
   * TailCandidate.eventTitle). Shown as a subtitle on the card. */
  eventTitle: string | null;
  outcome: string;
  side: "BUY" | "SELL";
  price: number;
  annualizedYieldPct: number;
  netReturnPct: number;
  daysToExpiry: number;
  nearDepthUsd: number;
  slippageBps: number;
  stabilityScore: number;
  decision: "actionable" | "observe" | "rejected";
  decisionReasons: string[];
  volume24hr: number;
  liquidity: number;
  marketUrl: string;
  endDate: string | null;
  /** Tags from the parent event (e.g. "Sports", "Crypto", "Weather") */
  tags: string[];
  /** All outcomes to token IDs for this market (for buying the opposite side) */
  outcomeTokens: Record<string, string>;
  /** Top ask levels at scan time (price asc). Used for size-sensitive recompute. */
  asks: AskLevel[];
  /** True when endDate has passed but the market is still accepting orders —
   * the "arbitrageur lag" window where real-world outcome is known but the
   * on-chain price hasn't converged to $1 yet. */
  awaitingResolution?: boolean;
  /** True when the parent market has a liquidity-rewards program
   * (Gamma `rewardsMinSize > 0`). Top of book is bot-maintained; we demote
   * these out of `actionable`. UI shows a badge. */
  rewardsIncentivized?: boolean;
  /** True for negRisk Multi-Strikes markets. Used by UI to label the card
   * as "one of N buckets" so users don't mistake a 94% No on a single bucket
   * for a real mispricing. */
  negRisk?: boolean;
  /** UMA oracle status: `'proposed'` / `'disputed'` / null. When non-null
   * the card is shown with an "oracle in progress" badge and the decision
   * is forced to `observe` at most. */
  umaResolutionStatus?: string | null;
  /** Latest resolution deadline parsed from the market description
   * ("resolve ... by Month D, YYYY"). Populated only when strictly later
   * than `endDate`; used for holding-day math and surfaced in the UI so
   * users see both the expected event date and the fallback deadline. */
  resolutionDeadline?: string | null;
  /** Gamma `sportsMarketType` — 'moneyline' / 'spreads' / 'totals' /
   * 'child_moneyline' / null. UI uses this to render a Spread/Totals badge
   * on sports tail markets and explain why the ~0.97 ask isn't a
   * mispricing. */
  sportsMarketType?: string | null;
  /** ISO kickoff time. Present for sports (and some live-event) markets
   * whose book gets cancelled at `clearBookOnStart`. The scanner hard-skips
   * any market whose kickoff is under 15 minutes away; in-play markets
   * (kickoff already past) are demoted to observe and badged since price
   * snapshots go stale within minutes. */
  gameStartTime?: string | null;
}

// ── Paper Trading ──

/** A single price level fill from walking the ask book */
export interface Fill {
  price: number;
  size: number;
  cost: number;
}

/** Preview / execution result from walking the asks for a USD amount */
export interface FillResult {
  shares: number;
  avgFillPrice: number;
  worstFillPrice: number;
  fills: Fill[];
  /** USD left over if the book was drained */
  remainingUsd: number;
}

/** A paper trade — what the user simulated buying */
export interface PaperTrade {
  id: string;
  conditionId: string;
  tokenId: string;
  marketQuestion: string;
  outcomeBought: string;
  marketUrl: string | null;
  endDate: string | null;
  usdAmount: number;
  shares: number;
  avgFillPrice: number;
  worstFillPrice: number;
  fills: Fill[];
  status: "open" | "won" | "lost" | "void";
  resolvedOutcome: string | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  createdAt: string;
  resolvedAt: string | null;
}

// ── Scan run summary ──
export interface ScanRun {
  scanId: string;
  marketsScanned: number;
  candidatesFound: number;
  actionableCount: number;
  observeCount: number;
  rejectedCount: number;
  durationMs: number;
  startedAt: string;
  completedAt: string | null;
}

// ── Combined response from scan API ──
export interface ScanResponse {
  scan: ScanRun;
  opportunities: Opportunity[];
}

// ── Filter state for the dashboard ──
export interface FilterState {
  decision: "all" | "actionable" | "observe" | "rejected";
  minYield: number | null;
  maxDaysToExpiry: number | null;
  sortBy: "yield" | "score" | "depth" | "expiry";
  /** Selected tag filters (multi-select, empty = show all) */
  tags: string[];
  /** Excluded tags — opportunities matching these are hidden */
  excludedTags: string[];
}
