"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { ScanResponse, FilterState, Opportunity } from "@/lib/types";
import { StatsBar } from "@/components/StatsBar";
import { ScanButton } from "@/components/ScanButton";
import { FilterBar } from "@/components/FilterBar";
import { OpportunityCard } from "@/components/OpportunityCard";
import {
  recomputeAtSize,
  sortWithDecisionPriority,
} from "@/lib/liveRecompute";
import {
  AWAITING_RESOLUTION_TAG,
  ORACLE_RESET_TAG,
  ORACLE_RESOLUTION_TAG,
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
    default:
      return false;
  }
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

/** Tags excluded by default when the dashboard loads (first visit only) */
const DEFAULT_EXCLUDED_TAGS = [
  "Weather", "Daily Temperature",
  "Crypto", "Bitcoin", "Ethereum", "Crypto Prices",
];

/** localStorage key for persisting user's tag selections */
const TAG_PREFS_KEY = "prededge.tagPrefs.v1";
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
      const res = await fetch("/api/scan", { method: "POST" });
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
      isVirtualTag(tag)
        ? matchesVirtualTag(opp, tag)
        : opp.tags?.includes(tag) === true;
    const oracleResolutionSelected = filters.tags.includes(
      ORACLE_RESOLUTION_TAG
    );
    const oracleResetSelected = filters.tags.includes(ORACLE_RESET_TAG);

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
        (oracleResetSelected && matchesVirtualTag(opp, ORACLE_RESET_TAG));
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
  const availableTags = [
    ...(hasAwaiting ? [AWAITING_RESOLUTION_TAG] : []),
    ...(hasOracleResolution ? [ORACLE_RESOLUTION_TAG] : []),
    ...(hasOracleReset ? [ORACLE_RESET_TAG] : []),
    ...realTags,
  ];

  return (
    <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">
            Tail Sweeping Scanner
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Find mispriced Polymarket contracts with high probability outcomes
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label
            htmlFor="trade-size"
            className="text-xs text-text-muted uppercase tracking-wider"
          >
            Trade Size
          </label>
          <div className="flex items-center bg-bg-input border border-border rounded px-2">
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
        <div className="bg-accent-red-dim/30 border border-accent-red/30 rounded-lg px-4 py-3 text-sm text-accent-red">
          {error}
        </div>
      )}

      {/* Stats */}
      <StatsBar scan={data?.scan ?? null} />

      {/* Filters */}
      <FilterBar filters={filters} onChange={setFilters} availableTags={availableTags} />

      {/* Results */}
      {loading && !data && (
        <div className="text-center py-20 text-text-muted">
          <div className="animate-pulse text-lg">Scanning Polymarket...</div>
          <div className="text-xs mt-2">
            This may take 30-60 seconds (fetching thousands of markets)
          </div>
        </div>
      )}

      {data && sortedFiltered.length === 0 && (
        <div className="text-center py-12 text-text-muted">
          No opportunities match your filters.
        </div>
      )}

      {sortedFiltered.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs text-text-muted">
            Showing {sortedFiltered.length} opportunities &middot; Yields
            computed at ${tradeSizeUsd.toLocaleString()} trade size
          </div>
          {sortedFiltered.map(({ opp, live }, idx) => (
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
