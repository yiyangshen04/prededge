"use client";

import { useState } from "react";
import type { FilterState } from "@/lib/types";
import { isVirtualTag } from "@/lib/virtualTags";

const decisions = ["all", "actionable", "observe", "rejected"] as const;
const sortOptions = [
  { value: "yield", label: "Ann. Yield" },
  { value: "score", label: "Score" },
  { value: "depth", label: "Depth" },
  { value: "expiry", label: "Expiry" },
] as const;

/** Primary tags shown by default (high-frequency, meaningful categories).
 * Virtual tags are always primary — they're state filters, not categories. */
const PRIMARY_TAGS = new Set([
  "Sports", "Crypto", "Politics", "Weather", "Finance",
  "Geopolitics", "Elections", "Economy", "Culture", "AI",
  "Soccer", "Basketball", "Hockey", "Esports", "Bitcoin",
  "Ethereum", "Stocks", "Iran", "Middle East", "Crypto Prices",
  "Daily Temperature", "Games", "Recurring",
]);

export function FilterBar({
  filters,
  onChange,
  availableTags = [],
}: {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  availableTags?: string[];
}) {
  const [showAllTags, setShowAllTags] = useState(false);

  /**
   * 3-state cycle: neutral → included → excluded → neutral
   * - neutral (gray): no filtering effect
   * - included (blue): must match
   * - excluded (red): must not match
   */
  const cycleTag = (tag: string) => {
    const isIncluded = filters.tags.includes(tag);
    const isExcluded = filters.excludedTags.includes(tag);

    if (isIncluded) {
      // included → excluded
      onChange({
        ...filters,
        tags: filters.tags.filter((t) => t !== tag),
        excludedTags: [...filters.excludedTags, tag],
      });
    } else if (isExcluded) {
      // excluded → neutral
      onChange({
        ...filters,
        excludedTags: filters.excludedTags.filter((t) => t !== tag),
      });
    } else {
      // neutral → included
      onChange({
        ...filters,
        tags: [...filters.tags, tag],
      });
    }
  };

  // Virtual tags always render first and are always primary (they represent
  // cross-cutting state filters, not event categories, so the user should
  // always see them when applicable without needing "+N more").
  const virtualTags = availableTags.filter(isVirtualTag);
  const realPrimary = availableTags.filter(
    (t) => !isVirtualTag(t) && PRIMARY_TAGS.has(t)
  );
  const otherTags = availableTags.filter(
    (t) => !isVirtualTag(t) && !PRIMARY_TAGS.has(t)
  );
  const displayedTags = showAllTags
    ? [...virtualTags, ...realPrimary, ...otherTags]
    : [...virtualTags, ...realPrimary];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* Decision filter */}
        <div className="flex rounded-lg border border-border overflow-hidden">
          {decisions.map((d) => (
            <button
              key={d}
              onClick={() => onChange({ ...filters, decision: d })}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                filters.decision === d
                  ? "bg-accent-blue text-white"
                  : "bg-bg-card text-text-secondary hover:text-text-primary"
              }`}
            >
              {d}
            </button>
          ))}
        </div>

        {/* Min yield */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-text-muted">Min Yield:</label>
          <input
            type="number"
            value={filters.minYield ?? ""}
            onChange={(e) =>
              onChange({
                ...filters,
                minYield: e.target.value ? parseFloat(e.target.value) : null,
              })
            }
            placeholder="0"
            className="w-16 bg-bg-input border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent-blue"
          />
          <span className="text-xs text-text-muted">%</span>
        </div>

        {/* Max days */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-text-muted">Max Days:</label>
          <input
            type="number"
            value={filters.maxDaysToExpiry ?? ""}
            onChange={(e) =>
              onChange({
                ...filters,
                maxDaysToExpiry: e.target.value
                  ? parseFloat(e.target.value)
                  : null,
              })
            }
            placeholder="∞"
            className="w-16 bg-bg-input border border-border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none focus:border-accent-blue"
          />
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-text-muted">Sort:</label>
          <select
            value={filters.sortBy}
            onChange={(e) =>
              onChange({
                ...filters,
                sortBy: e.target.value as FilterState["sortBy"],
              })
            }
            className="bg-bg-input border border-border rounded px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-accent-blue"
          >
            {sortOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Tag filter (multi-select) */}
      {availableTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-text-muted mr-1">Tags:</span>
          {(filters.tags.length > 0 || filters.excludedTags.length > 0) && (
            <button
              onClick={() => onChange({ ...filters, tags: [], excludedTags: [] })}
              className="px-2 py-0.5 text-[10px] rounded border border-accent-red/30 text-accent-red hover:bg-accent-red/10 transition-colors"
            >
              Clear
            </button>
          )}
          <button
            onClick={() =>
              onChange({
                ...filters,
                tags: [],
                excludedTags: [...new Set([...filters.excludedTags, ...availableTags])],
              })
            }
            className="px-2 py-0.5 text-[10px] rounded border border-border text-text-muted hover:text-text-primary hover:border-accent-red/40 transition-colors"
          >
            Deselect All
          </button>
          {displayedTags.map((tag) => {
            const isIncluded = filters.tags.includes(tag);
            const isExcluded = filters.excludedTags.includes(tag);
            const virtual = isVirtualTag(tag);
            // Virtual tags use the amber "awaiting" palette (neutral state
            // only) so they pair visually with the matching card badge.
            // Included / excluded states stay on the shared blue/red palette
            // so the 3-state cycle reads consistently across all chips.
            const neutralClass = virtual
              ? "bg-accent-amber/10 text-accent-amber border-accent-amber/40 hover:bg-accent-amber/20"
              : "bg-bg-card text-text-secondary border-border hover:border-accent-blue/40";
            return (
              <button
                key={tag}
                onClick={() => cycleTag(tag)}
                className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                  isIncluded
                    ? "bg-accent-blue text-white border-accent-blue"
                    : isExcluded
                      ? "bg-accent-red/10 text-accent-red border-accent-red/30 line-through"
                      : neutralClass
                }`}
              >
                {tag}
              </button>
            );
          })}
          {otherTags.length > 0 && (
            <button
              onClick={() => setShowAllTags(!showAllTags)}
              className="px-2 py-0.5 text-[10px] rounded border border-border text-text-muted hover:text-text-primary transition-colors"
            >
              {showAllTags ? `Show less` : `+${otherTags.length} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
