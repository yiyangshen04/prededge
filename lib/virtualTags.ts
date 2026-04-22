/**
 * Virtual tags — synthetic chips that appear in the FilterBar alongside real
 * event tags but match against Opportunity fields other than `tags`. They let
 * us surface cross-cutting states (e.g. "market is in the arbitrageur-lag
 * resolution window") without polluting `opp.tags`, which is sourced from
 * Polymarket's event tag API.
 */

/** Filter for opportunities where the underlying market is past its endDate
 * but still accepting orders — the arbitrageur-lag window. */
export const AWAITING_RESOLUTION_TAG = "Awaiting Resolution";

/** All virtual tag labels. FilterBar styles these differently from real tags
 * and page.tsx routes them to field-specific predicates instead of
 * `opp.tags.includes(...)`. */
export const VIRTUAL_TAGS = new Set<string>([AWAITING_RESOLUTION_TAG]);

export function isVirtualTag(tag: string): boolean {
  return VIRTUAL_TAGS.has(tag);
}
