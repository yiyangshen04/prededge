/**
 * Parse the market's "resolution deadline" out of the Gamma `description`.
 *
 * Why we need this: Gamma's top-level `endDate` is typically the *expected*
 * event date (e.g. FDA PDUFA date, election day), not the latest date the
 * market can still resolve. For PDUFA markets in particular, `endDate` can
 * be two weeks before the real resolution deadline shown in the market
 * description ("resolve ... by May 7, 2026, 11:59 PM ET"). Using the short
 * `endDate` for holding-days math inflates annualized yield by 10×+.
 *
 * We look for "by <Month> <Day>, <Year>" / "before ..." / "until ..." /
 * "deadline of ..." patterns and return the ISO date of the *latest* such
 * mention found. When no plausible pattern matches, we return null and the
 * caller falls back to the Gamma endDate.
 */

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_PATTERN = MONTH_NAMES.join("|");

// "by May 7, 2026" (case-insensitive); trailing ", 11:59 PM ET" etc ignored.
const DEADLINE_RE = new RegExp(
  String.raw`\b(?:by|before|until|deadline\s+of|no\s+later\s+than)\s+(` +
    String.raw`(?:${MONTH_PATTERN})\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}` +
    String.raw`)\b`,
  "gi",
);

function parseMatchedDate(s: string): Date | null {
  const cleaned = s.replace(/(\d+)(?:st|nd|rd|th)/, "$1");
  const d = new Date(cleaned + " 23:59:59 UTC");
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Return the latest deadline-style date mentioned in `description` as an ISO
 * string (UTC, end-of-day 23:59:59Z — Polymarket deadlines are "end of day ET"
 * which 23:59:59Z approximates closely enough for holding-day math). If
 * nothing plausible is found or every match is earlier than `fallbackEndDate`,
 * returns null.
 */
export function parseResolutionDeadline(
  description: string | null | undefined,
  fallbackEndDate: string | null,
): string | null {
  if (!description) return null;
  const matches = description.matchAll(DEADLINE_RE);
  let latest: Date | null = null;
  for (const m of matches) {
    const d = parseMatchedDate(m[1]);
    if (!d) continue;
    if (!latest || d.getTime() > latest.getTime()) latest = d;
  }
  if (!latest) return null;

  // Only return the parsed deadline when it's strictly after the Gamma
  // endDate by more than a day — otherwise the two refer to the same event
  // and there's no point overriding the more-structured field.
  if (fallbackEndDate) {
    const fallback = new Date(fallbackEndDate);
    if (!isNaN(fallback.getTime())) {
      const diffDays =
        (latest.getTime() - fallback.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays <= 1) return null;
    }
  }
  return latest.toISOString();
}
