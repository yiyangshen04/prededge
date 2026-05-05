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

/** Filter for markets whose UMA proposal/dispute process is already active.
 * These are distinct from normal awaiting-resolution windows because the
 * oracle has entered `proposed` or `disputed` state. */
export const ORACLE_RESOLUTION_TAG = "Oracle Resolution";

/** Filter for markets whose first UMA dispute reset the Adapter request, but
 * the current request has no active proposal and no available price. */
export const ORACLE_RESET_TAG = "Oracle Reset";

/** Filter for markets where the post-reset re-proposal was disputed again —
 * the question has been escalated to UMA DVM full-vote (48-72h). Outcome is
 * no longer locally inferable; we surface them so users can track the queue
 * separately from the still-actionable Reset state. */
export const ORACLE_SECOND_DISPUTE_TAG = "Oracle Second Dispute";

/** All virtual tag labels. FilterBar styles these differently from real tags
 * and page.tsx routes them to field-specific predicates instead of
 * `opp.tags.includes(...)`. */
export const VIRTUAL_TAGS = new Set<string>([
  AWAITING_RESOLUTION_TAG,
  ORACLE_RESOLUTION_TAG,
  ORACLE_RESET_TAG,
  ORACLE_SECOND_DISPUTE_TAG,
]);

export function isVirtualTag(tag: string): boolean {
  return VIRTUAL_TAGS.has(tag);
}

/** Meta tags the scanner surfaces from Polymarket but that shouldn't appear
 * in the FilterBar or card chips. Stored lowercase and compared via
 * `.toLowerCase()` so Gamma casing drift can't let a chip show in one place
 * and vanish from another (which would produce a filter that matches zero
 * visible cards). */
const HIDDEN_TAGS_LC = new Set<string>([
  "hide from new",
  "rewards automation 50 4.5 50",
]);

export function isHiddenTag(tag: string): boolean {
  return HIDDEN_TAGS_LC.has(tag.toLowerCase());
}
