/**
 * US federal holidays (Monday-only) and MSTR earnings dates.
 *
 * Hardcoded for 2024-2030. When the table needs extending, just append rows —
 * the report's 80-week dataset only covers 2024-11 through 2026-05, so we
 * have headroom.
 *
 * The "Monday-only" filter matters: only Monday holidays push the 8-K to
 * Tuesday and cause Polymarket window misalignment. (Christmas / July 4th /
 * Thanksgiving don't always fall on Monday and don't affect the 8-K
 * schedule the same way.)
 */

/** ISO yyyy-mm-dd. All entries are Mondays. */
export const FEDERAL_HOLIDAYS_2024_2030: ReadonlyArray<{
  date: string;
  name: string;
}> = [
  // 2024
  { date: "2024-01-15", name: "MLK Day" },
  { date: "2024-02-19", name: "Presidents Day" },
  { date: "2024-05-27", name: "Memorial Day" },
  { date: "2024-09-02", name: "Labor Day" },
  { date: "2024-10-14", name: "Columbus Day" },
  // 2025
  { date: "2025-01-20", name: "MLK Day / Inauguration Day" },
  { date: "2025-02-17", name: "Presidents Day" },
  { date: "2025-05-26", name: "Memorial Day" },
  { date: "2025-09-01", name: "Labor Day" },
  { date: "2025-10-13", name: "Columbus Day" },
  // 2026
  { date: "2026-01-19", name: "MLK Day" },
  { date: "2026-02-16", name: "Presidents Day" },
  { date: "2026-05-25", name: "Memorial Day" },
  { date: "2026-09-07", name: "Labor Day" },
  { date: "2026-10-12", name: "Columbus Day" },
  // 2027
  { date: "2027-01-18", name: "MLK Day" },
  { date: "2027-02-15", name: "Presidents Day" },
  { date: "2027-05-31", name: "Memorial Day" },
  { date: "2027-09-06", name: "Labor Day" },
  { date: "2027-10-11", name: "Columbus Day" },
  // 2028
  { date: "2028-01-17", name: "MLK Day" },
  { date: "2028-02-21", name: "Presidents Day" },
  { date: "2028-05-29", name: "Memorial Day" },
  { date: "2028-09-04", name: "Labor Day" },
  { date: "2028-10-09", name: "Columbus Day" },
  // 2029
  { date: "2029-01-15", name: "MLK Day / Inauguration Day" },
  { date: "2029-02-19", name: "Presidents Day" },
  { date: "2029-05-28", name: "Memorial Day" },
  { date: "2029-09-03", name: "Labor Day" },
  { date: "2029-10-08", name: "Columbus Day" },
  // 2030
  { date: "2030-01-21", name: "MLK Day" },
  { date: "2030-02-18", name: "Presidents Day" },
  { date: "2030-05-27", name: "Memorial Day" },
  { date: "2030-09-02", name: "Labor Day" },
  { date: "2030-10-14", name: "Columbus Day" },
];

const HOLIDAY_SET = new Set(FEDERAL_HOLIDAYS_2024_2030.map((h) => h.date));

/**
 * MSTR earnings dates (estimated for 2026; verified for 2024-2025).
 * Window radius: ±14 days around each date is treated as MNPI blackout.
 */
export const MSTR_EARNINGS_DATES: ReadonlyArray<string> = [
  "2024-02-06",
  "2024-04-29",
  "2024-07-31",
  "2024-10-30",
  "2025-02-05",
  "2025-04-28",
  "2025-07-31",
  "2025-10-30",
  "2026-02-04",
  "2026-05-05",
  "2026-07-30",
  "2026-10-29",
  "2027-02-03",
  "2027-04-28",
  "2027-07-29",
  "2027-10-28",
];

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BLACKOUT_RADIUS_DAYS = 14;

/** ISO yyyy-mm-dd → Date at UTC midnight. */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Returns the Monday of the week containing `d`, as ISO yyyy-mm-dd. */
export function mondayOf(d: Date): string {
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day; // back to Monday
  const monday = new Date(d.getTime() + diff * DAY_MS);
  return toIsoDate(monday);
}

/**
 * Returns the Sunday closing the same week as `d`, as ISO yyyy-mm-dd.
 *
 * Earlier code computed this as `mondayOf(now + 6d)`, which always returns
 * a Monday (the same Monday for any Mon-Sun input, or next Monday for Tue-Sat).
 * Use this helper instead.
 */
export function sundayOf(d: Date): string {
  const mondayMs = new Date(mondayOf(d) + "T00:00:00Z").getTime();
  const sunday = new Date(mondayMs + 6 * DAY_MS);
  return toIsoDate(sunday);
}

/** Returns true iff the given date's *Monday* is a federal Monday-holiday. */
export function isHolidayMonday(d: Date): boolean {
  return HOLIDAY_SET.has(mondayOf(d));
}

export function holidayName(d: Date): string | null {
  const m = mondayOf(d);
  return FEDERAL_HOLIDAYS_2024_2030.find((h) => h.date === m)?.name ?? null;
}

/**
 * True iff `d` falls inside an MSTR earnings blackout window.
 *
 * Per the report ("财报前 1-2 周"), the blackout is the **lead-up** to a
 * reporting date, not a symmetric window. Once results are public, MNPI is
 * gone and Strategy can resume buying within ~1-2 trading days. We also
 * apply a small `postReleaseGraceDays=2` after the release just to keep the
 * predictor conservative through earnings call day itself.
 *
 *   blackout iff d ∈ [earningsDate − radiusDays,  earningsDate + 2 days]
 *
 * Tested anchors from the report:
 *   - 2025-04-25 (Q1 2025 = 4/28) → true   (3 days pre)
 *   - 2025-07-22 (Q2 2025 = 7/31) → true   (9 days pre, matches #39 NO)
 *   - 2026-05-11 (Q1 2026 = 5/5)  → false  (6 days post-release, MNPI gone)
 */
export function isEarningsBlackout(
  d: Date,
  radiusDays: number = DEFAULT_BLACKOUT_RADIUS_DAYS,
  postReleaseGraceDays: number = 2
): boolean {
  const t = d.getTime();
  const preRadius = radiusDays * DAY_MS;
  const postRadius = postReleaseGraceDays * DAY_MS;
  for (const dateStr of MSTR_EARNINGS_DATES) {
    const e = new Date(`${dateStr}T00:00:00Z`).getTime();
    const delta = t - e;
    // delta < 0  ⇒ d is BEFORE earnings (lead-up)
    // delta > 0  ⇒ d is AFTER earnings (post-release)
    if (delta <= 0 && -delta <= preRadius) return true;
    if (delta > 0 && delta <= postRadius) return true;
  }
  return false;
}

export function nextEarningsDate(d: Date): string | null {
  const t = d.getTime();
  for (const dateStr of MSTR_EARNINGS_DATES) {
    const e = new Date(`${dateStr}T00:00:00Z`).getTime();
    if (e >= t) return dateStr;
  }
  return null;
}

/** Helper for week-window math. */
export function weekRange(weekStart: string): { start: Date; end: Date } {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start.getTime() + 7 * DAY_MS - 1);
  return { start, end };
}
