"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { ScanResponse, FilterState, Opportunity } from "@/lib/types";
import { StatsBar } from "@/components/StatsBar";
import { ScanButton } from "@/components/ScanButton";
import { FilterBar } from "@/components/FilterBar";
import { OnchainEventsBar } from "@/components/OnchainEventsBar";
import {
  OpportunityCard,
  isDivergenceLegOpp,
  isDivergencePlay,
} from "@/components/OpportunityCard";
import {
  recomputeAtSize,
  sortWithDecisionPriority,
} from "@/lib/liveRecompute";
import {
  AWAITING_RESOLUTION_TAG,
  OFFICIAL_RULING_TAG,
  ORACLE_RESET_TAG,
  ORACLE_RESOLUTION_TAG,
  ORACLE_SECOND_DISPUTE_TAG,
  isDirectionalStance,
  isHiddenTag,
  isVirtualTag,
} from "@/lib/virtualTags";

/** True iff the opportunity matches the named virtual tag. Virtual tags
 * don't live in `opp.tags` — they're derived from other Opportunity fields
 * so we can filter cross-cutting states (e.g. the resolution-lag window). */
function matchesVirtualTag(opp: Opportunity, tag: string): boolean {
  switch (tag) {
    case AWAITING_RESOLUTION_TAG:
      return opp.awaitingResolution === true;
    case ORACLE_RESOLUTION_TAG:
      return hasOracleResolutionStatus(opp.umaResolutionStatus);
    case ORACLE_RESET_TAG:
      return isOracleResetStalled(opp);
    case ORACLE_SECOND_DISPUTE_TAG:
      return isOracleSecondDispute(opp);
    case OFFICIAL_RULING_TAG:
      return isOfficialRulingSection(opp);
    default:
      return false;
  }
}

/** The Official Ruling class: a disputed market where the official on-chain
 * context implies a direction AND this opportunity sits on the favored side.
 * The contradicted side stays in the main list with its demotion badge. */
function isOfficialRulingPinned(opp: Opportunity): boolean {
  return (
    opp.officialContext != null &&
    isDirectionalStance(opp.officialContext.stance) &&
    opp.decisionReasons?.includes("official_direction_backed") === true
  );
}

/** Everything shown in the pinned Official Ruling section: officially-backed
 * favored sides PLUS all divergence legs (trailing <0.5 sides of disputed
 * markets). Divergence legs belong here by default — the text-backed ones are
 * the site's top-priority signal and the unbacked ones give the pair context. */
function isOfficialRulingSection(opp: Opportunity): boolean {
  return isOfficialRulingPinned(opp) || isDivergenceLegOpp(opp);
}

function hasOracleResolutionStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim();
  return (
    normalized != null &&
    normalized.length > 0 &&
    normalized.toLowerCase() !== "none"
  );
}

function isOracleResetStalled(opp: Opportunity): boolean {
  return (
    opp.oracleResolutionState === "reset_stalled" ||
    opp.decisionReasons?.includes("oracle_reset_stalled") === true
  );
}

function isOracleSecondDispute(opp: Opportunity): boolean {
  return (
    opp.oracleResolutionState === "second_dispute" ||
    opp.decisionReasons?.includes("oracle_second_dispute") === true
  );
}

/** Tags excluded by default when the dashboard loads (first visit only).
 * "Sports" matches via `sportsMarketType` so individual leagues are covered;
 * Esports/Soccer are listed because not every such market carries the field.
 * Weather/crypto variants mirror the tag vocabulary seen in scan data. */
const DEFAULT_EXCLUDED_TAGS = [
  "Sports", "Soccer", "Esports",
  "Weather", "Daily Temperature", "Highest temperature", "Lowest temperature",
  "Crypto", "Bitcoin", "Ethereum", "Crypto Prices", "XRP", "Solana",
  "Dogecoin", "Stablecoins", "Daily-Close",
];

/** localStorage key for persisting user's tag selections.
 * v3 resets old saved prefs so the expanded weather/sports/crypto exclusion
 * set applies to existing browsers too. */
const TAG_PREFS_KEY = "prededge.tagPrefs.v3";
/** localStorage key for persisting the user's trade-size input */
const TRADE_SIZE_KEY = "prededge.tradeSize.v1";
/** Default trade size in USD — matches DEFAULT_SCAN_CONFIG.minDepthUsd */
const DEFAULT_TRADE_SIZE = 200;

interface TagPrefs {
  tags: string[];
  excludedTags: string[];
}

function loadTagPrefs(): TagPrefs | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(TAG_PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.tags) || !Array.isArray(parsed?.excludedTags)) {
      return null;
    }
    return {
      tags: parsed.tags.map(String),
      excludedTags: parsed.excludedTags.map(String),
    };
  } catch {
    return null;
  }
}

function saveTagPrefs(prefs: TagPrefs) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(TAG_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // quota exceeded or storage disabled — silent fallback
  }
}

export default function Dashboard() {
  const [data, setData] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [tradeSizeUsd, setTradeSizeUsd] = useState<number>(DEFAULT_TRADE_SIZE);
  const [filters, setFilters] = useState<FilterState>({
    decision: "all",
    minYield: null,
    maxDaysToExpiry: null,
    sortBy: "yield",
    tags: [],
    excludedTags: DEFAULT_EXCLUDED_TAGS,
  });

  // Hydrate tag selections & trade size from localStorage on mount
  useEffect(() => {
    const saved = loadTagPrefs();
    if (saved) {
      setFilters((f) => ({
        ...f,
        tags: saved.tags,
        excludedTags: saved.excludedTags,
      }));
    }
    if (typeof window !== "undefined") {
      const raw = window.localStorage.getItem(TRADE_SIZE_KEY);
      const parsed = raw != null ? Number(raw) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) {
        setTradeSizeUsd(parsed);
      }
    }
    setPrefsLoaded(true);
  }, []);

  // Persist trade size whenever it changes (after hydration)
  useEffect(() => {
    if (!prefsLoaded || typeof window === "undefined") return;
    window.localStorage.setItem(TRADE_SIZE_KEY, String(tradeSizeUsd));
  }, [tradeSizeUsd, prefsLoaded]);

  // Persist tag selections whenever they change (after initial hydration)
  useEffect(() => {
    if (!prefsLoaded) return;
    saveTagPrefs({
      tags: filters.tags,
      excludedTags: filters.excludedTags,
    });
  }, [filters.tags, filters.excludedTags, prefsLoaded]);

  // `maxDaysToExpiry` is driven by a numeric <input> whose onChange fires on
  // every keystroke; without debouncing, typing "30" would fire two fetches
  // (for 3, then 30) and the earlier response could land last and clobber
  // the newer one. We debounce the value before it enters fetchLatest's
  // closure, and guard the fetch itself with an AbortController so even if a
  // user types fast enough to miss the debounce window, the stale response
  // is thrown away rather than overwriting `data`.
  const [debouncedMaxDays, setDebouncedMaxDays] = useState<number | null>(
    filters.maxDaysToExpiry
  );
  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedMaxDays(filters.maxDaysToExpiry),
      300
    );
    return () => clearTimeout(t);
  }, [filters.maxDaysToExpiry]);

  // Load latest scan on mount. Sorting AND minYield filtering are applied
  // client-side (see `sortedFiltered`) because they depend on tradeSizeUsd,
  // which the server doesn't know — filtering on the stored baseline would
  // reject rows that are actionable at the user's size (or vice versa).
  const fetchLatest = useCallback(async (signal: AbortSignal) => {
    try {
      const params = new URLSearchParams();
      if (filters.decision !== "all") params.set("decision", filters.decision);
      if (debouncedMaxDays != null)
        params.set("maxDays", String(debouncedMaxDays));

      const res = await fetch(`/api/scan?${params}`, { signal });
      if (res.ok) {
        const json = await res.json();
        setData(json);
        setError(null);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      // No scan data yet, that's fine
    }
  }, [filters.decision, debouncedMaxDays]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchLatest(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchLatest]);

  // Trigger a new scan
  const runScan = async () => {
    setLoading(true);
    setError(null);
    try {
      const scanTagFilters = {
        tags: filters.tags.filter((tag) => !isVirtualTag(tag)),
        excludedTags: filters.excludedTags.filter((tag) => !isVirtualTag(tag)),
      };
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scanTagFilters),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || `Scan failed (${res.status})`);
      }
      const json: ScanResponse = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  };

  // Tag filtering + per-opportunity recompute at the current trade size,
  // then decision-first sort (actionable → observe → rejected, then sortBy
  // tiebreaker). Sorting lives here rather than in the GET handler because
  // the yield depends on tradeSizeUsd, which is a client-only input.
  const sortedFiltered = useMemo(() => {
    const opps = data?.opportunities ?? [];
    const matchesTag = (opp: Opportunity, tag: string) =>
      tag === "Sports" && opp.sportsMarketType != null
        ? true
        : isVirtualTag(tag)
          ? matchesVirtualTag(opp, tag)
          : opp.tags?.includes(tag) === true;
    const oracleResolutionSelected = filters.tags.includes(
      ORACLE_RESOLUTION_TAG
    );
    const oracleResetSelected = filters.tags.includes(ORACLE_RESET_TAG);
    const oracleSecondDisputeSelected = filters.tags.includes(
      ORACLE_SECOND_DISPUTE_TAG
    );
    const officialRulingSelected = filters.tags.includes(OFFICIAL_RULING_TAG);

    const keep = opps.filter((opp) => {
      if (
        filters.tags.length > 0 &&
        !filters.tags.some((tag) => matchesTag(opp, tag))
      ) {
        return false;
      }
      // Oracle Resolution is a cross-tag settlement state. When that virtual
      // tag is selected, it should include all oracle-flow markets even if
      // their real Polymarket tags are manually excluded in the UI.
      const skipExclusions =
        (oracleResolutionSelected &&
          matchesVirtualTag(opp, ORACLE_RESOLUTION_TAG)) ||
        (oracleResetSelected && matchesVirtualTag(opp, ORACLE_RESET_TAG)) ||
        (oracleSecondDisputeSelected &&
          matchesVirtualTag(opp, ORACLE_SECOND_DISPUTE_TAG)) ||
        (officialRulingSelected && matchesVirtualTag(opp, OFFICIAL_RULING_TAG));
      if (
        !skipExclusions &&
        filters.excludedTags.length > 0 &&
        filters.excludedTags.some((tag) => matchesTag(opp, tag))
      ) {
        return false;
      }
      return true;
    });
    const withLive = keep.map((opp) => ({
      opp,
      live: recomputeAtSize(opp, tradeSizeUsd),
    }));
    // minYield compares against the live yield (at the user's trade size),
    // not the $200 baseline stored on `opp`, so the filter matches what
    // the user actually sees on each card.
    const minYieldFiltered =
      filters.minYield != null
        ? withLive.filter(({ live }) => live.annualizedYieldPct >= filters.minYield!)
        : withLive;
    return sortWithDecisionPriority(minYieldFiltered, filters.sortBy);
  }, [
    data?.opportunities,
    filters.tags,
    filters.excludedTags,
    filters.sortBy,
    filters.minYield,
    tradeSizeUsd,
  ]);

  // Pinned "Official Ruling" section: disputed markets where the official
  // on-chain context implies the direction and this side is the favored one,
  // plus all divergence legs (see isOfficialRulingSection).
  // Deliberately bypasses tag filters (the class is rare and high-signal —
  // a disputed sports market must not vanish behind the default Sports
  // exclusion); decision/maxDays filtering still applies server-side via GET.
  const pinned = useMemo(() => {
    const opps = (data?.opportunities ?? []).filter(isOfficialRulingSection);
    const withLive = opps.map((opp) => ({
      opp,
      live: recomputeAtSize(opp, tradeSizeUsd),
    }));
    // Divergence plays (text-backed trailing legs) lead the section — they
    // are the site-wide top-priority signal; the rest sort by net return.
    withLive.sort((a, b) => {
      const aPlay = isDivergencePlay(a.opp) ? 1 : 0;
      const bPlay = isDivergencePlay(b.opp) ? 1 : 0;
      if (aPlay !== bPlay) return bPlay - aPlay;
      return b.live.netReturnPct - a.live.netReturnPct;
    });
    return withLive;
  }, [data?.opportunities, tradeSizeUsd]);

  const mainList = useMemo(() => {
    if (pinned.length === 0) return sortedFiltered;
    const pinnedTokenIds = new Set(pinned.map(({ opp }) => opp.tokenId));
    return sortedFiltered.filter(({ opp }) => !pinnedTokenIds.has(opp.tokenId));
  }, [sortedFiltered, pinned]);

  // Collect all available tags from current data for the filter UI. Virtual
  // tags (e.g. Awaiting Resolution) get prepended if any opportunity in the
  // current dataset matches — otherwise we hide them to avoid dead chips.
  const realTags = [
    ...new Set(
      (data?.opportunities ?? [])
        .flatMap((o) => o.tags ?? [])
        .filter((t) => !isHiddenTag(t))
    ),
  ].sort();

  const hasAwaiting = (data?.opportunities ?? []).some(
    (o) => o.awaitingResolution === true
  );
  const hasOracleResolution = (data?.opportunities ?? []).some(
    (o) => hasOracleResolutionStatus(o.umaResolutionStatus)
  );
  const hasOracleReset = (data?.opportunities ?? []).some(isOracleResetStalled);
  const hasOracleSecondDispute = (data?.opportunities ?? []).some(
    isOracleSecondDispute
  );
  const hasOfficialRuling = (data?.opportunities ?? []).some(
    isOfficialRulingSection
  );
  const availableTags = [
    ...(hasOfficialRuling ? [OFFICIAL_RULING_TAG] : []),
    ...(hasAwaiting ? [AWAITING_RESOLUTION_TAG] : []),
    ...(hasOracleResolution ? [ORACLE_RESOLUTION_TAG] : []),
    ...(hasOracleReset ? [ORACLE_RESET_TAG] : []),
    ...(hasOracleSecondDispute ? [ORACLE_SECOND_DISPUTE_TAG] : []),
    ...realTags,
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            Tail Sweeping Scanner
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Find mispriced Polymarket contracts with high probability outcomes
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label
            htmlFor="trade-size"
            className="text-[10px] text-text-muted uppercase tracking-[0.12em]"
          >
            Trade Size
          </label>
          <div className="flex items-center h-9 bg-bg-input border border-border rounded-lg px-2 focus-within:border-accent-blue/60 transition-colors">
            <span className="text-text-muted text-sm">$</span>
            <input
              id="trade-size"
              type="number"
              min="1"
              step="10"
              value={tradeSizeUsd}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setTradeSizeUsd(Number.isFinite(v) && v > 0 ? v : 1);
              }}
              className="w-24 bg-transparent px-1 py-1.5 font-mono text-sm text-text-primary focus:outline-none"
            />
          </div>
          <ScanButton loading={loading} onClick={runScan} />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-accent-red/10 border border-accent-red/30 rounded-lg px-4 py-3 text-sm text-accent-red">
          {error}
        </div>
      )}

      {/* Stats */}
      <StatsBar scan={data?.scan ?? null} />

      {/* On-chain event sweep since the previous scan. Only fresh POST
          responses carry the field; hidden for runs loaded from the DB. */}
      <OnchainEventsBar events={data?.onchainEvents} />

      {/* Filters */}
      <FilterBar filters={filters} onChange={setFilters} availableTags={availableTags} />

      {/* Results */}
      {loading && !data && (
        <div className="card px-6 py-20 text-center text-text-muted">
          <div className="animate-pulse text-lg text-text-secondary">
            Scanning Polymarket…
          </div>
          <div className="text-xs mt-2">
            This may take 30-60 seconds (fetching thousands of markets)
          </div>
        </div>
      )}

      {/* Pinned Official Ruling section — the product core. Always shown when
          present, regardless of tag filters; includes all divergence legs. */}
      {pinned.length > 0 && (
        <section className="section-official p-4 sm:p-5 space-y-3">
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-sm font-bold text-accent-gold uppercase tracking-[0.14em]">
                Official Ruling
              </span>
              <span className="chip chip-neutral">
                {pinned.length} market{pinned.length === 1 ? "" : "s"}
              </span>
              {pinned.some(({ opp }) => isDivergencePlay(opp)) && (
                <span
                  className="chip chip-gold"
                  title="At least one trailing leg here is backed by high-confidence official text — the highest-priority signal on the site."
                >
                  ★ divergence play live
                </span>
              )}
            </div>
            <p className="text-xs text-text-muted mt-1.5 max-w-3xl">
              Disputed markets where Polymarket&apos;s official on-chain context
              implies the resolution direction — historically 32/32 settled the
              official way. Divergence legs (the trailing side of a dispute)
              are pinned here too: gold-framed ones are text-backed and
              actionable, unbacked ones stay capped at observe. Shown
              regardless of tag filters.
            </p>
          </div>
          <div className="space-y-3">
            {pinned.map(({ opp, live }, idx) => (
              <OpportunityCard
                key={`pinned-${opp.tokenId}-${idx}`}
                opp={opp}
                live={live}
                tradeSizeUsd={tradeSizeUsd}
              />
            ))}
          </div>
        </section>
      )}

      {data && pinned.length === 0 && mainList.length === 0 && (
        <div className="card border-dashed px-6 py-14 text-center text-text-muted text-sm">
          No opportunities match your filters.
        </div>
      )}

      {mainList.length > 0 && (
        <div className="space-y-3">
          <div className="text-[11px] text-text-muted px-0.5">
            Showing{" "}
            <span className="font-mono text-text-secondary">
              {mainList.length}
            </span>{" "}
            opportunities &middot; Yields computed at{" "}
            <span className="font-mono text-text-secondary">
              ${tradeSizeUsd.toLocaleString()}
            </span>{" "}
            trade size
          </div>
          {mainList.map(({ opp, live }, idx) => (
            <OpportunityCard
              key={`${opp.tokenId}-${idx}`}
              opp={opp}
              live={live}
              tradeSizeUsd={tradeSizeUsd}
            />
          ))}
        </div>
      )}
    </div>
  );
}
