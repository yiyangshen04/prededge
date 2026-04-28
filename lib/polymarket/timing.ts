import type { GammaMarket } from "../types";
import { parseResolutionDeadline } from "./resolutionDeadline";

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const MONTH_INDEX = new Map(MONTHS.map((m, i) => [m, i]));
const MONTH_PATTERN = MONTHS.join("|");

const MONTH_DATE_RE = new RegExp(
  String.raw`\b(${MONTH_PATTERN})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`,
  "gi"
);

const SAME_MONTH_RANGE_RE = new RegExp(
  String.raw`\b(${MONTH_PATTERN})\s+(\d{1,2})(?:st|nd|rd|th)?\s*[-–]\s*(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`,
  "gi"
);

const ISO_DATE_RE = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g;

type TimingConfidence = "high" | "medium" | "low";

interface DateCandidate {
  iso: string;
  source: "question" | "slug" | "description";
  explicitYear: boolean;
}

export interface MarketTiming {
  rawEndDate: string | null;
  eventDeadline: string | null;
  resolutionDeadline: string | null;
  expectedPayoutDate: string | null;
  staleRawEndDate: boolean;
  recurrentLike: boolean;
  postponed: boolean;
  awaitingResolution: boolean;
  confidence: TimingConfidence;
  reasons: string[];
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  let d = new Date(value);
  if (!isNaN(d.getTime())) return d;

  // Gamma sometimes returns "2026-05-03 20:00:00+00" for gameStartTime.
  d = new Date(value.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

function endOfUtcDay(year: number, monthIndex: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, monthIndex, day, 23, 59, 59));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== monthIndex ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

function inferYear(
  monthIndex: number,
  day: number,
  explicitYear: string | undefined,
  market: GammaMarket,
  nowMs: number
): number | null {
  if (explicitYear) return Number(explicitYear);

  const rawEnd = parseTimestamp(market.endDate);
  const lowerBounds = [
    parseTimestamp(market.startDate),
    parseTimestamp(market.createdAt),
    parseTimestamp(market.acceptingOrdersTimestamp),
  ].filter((d): d is Date => d != null);

  if (rawEnd) {
    let year = rawEnd.getUTCFullYear();
    let candidate = endOfUtcDay(year, monthIndex, day);
    const latestLower = lowerBounds.reduce<Date | null>(
      (latest, d) => (!latest || d.getTime() > latest.getTime() ? d : latest),
      null
    );

    if (candidate && latestLower && candidate.getTime() < latestLower.getTime() - DAY_MS) {
      year = latestLower.getUTCFullYear();
      candidate = endOfUtcDay(year, monthIndex, day);
      if (candidate && candidate.getTime() < latestLower.getTime() - DAY_MS) {
        year += 1;
      }
    }
    return year;
  }

  let year = new Date(nowMs).getUTCFullYear();
  const candidate = endOfUtcDay(year, monthIndex, day);
  if (candidate && candidate.getTime() < nowMs - 60 * DAY_MS) {
    year += 1;
  }
  return year;
}

function pushMonthDate(
  out: DateCandidate[],
  source: DateCandidate["source"],
  monthName: string,
  dayRaw: string,
  yearRaw: string | undefined,
  market: GammaMarket,
  nowMs: number
) {
  const monthIndex = MONTH_INDEX.get(
    monthName.toLowerCase() as (typeof MONTHS)[number]
  );
  if (monthIndex == null) return;
  const day = Number(dayRaw);
  const year = inferYear(monthIndex, day, yearRaw, market, nowMs);
  if (year == null) return;
  const d = endOfUtcDay(year, monthIndex, day);
  if (!d) return;
  out.push({
    iso: d.toISOString(),
    source,
    explicitYear: yearRaw != null,
  });
}

function extractDateCandidates(
  text: string | null | undefined,
  source: DateCandidate["source"],
  market: GammaMarket,
  nowMs: number
): DateCandidate[] {
  if (!text) return [];
  const normalized = source === "slug" ? text.replace(/-/g, " ") : text;
  const out: DateCandidate[] = [];

  for (const m of normalized.matchAll(SAME_MONTH_RANGE_RE)) {
    pushMonthDate(out, source, m[1], m[3], m[4], market, nowMs);
  }
  for (const m of normalized.matchAll(MONTH_DATE_RE)) {
    pushMonthDate(out, source, m[1], m[2], m[3], market, nowMs);
  }
  for (const m of text.matchAll(ISO_DATE_RE)) {
    const d = endOfUtcDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!d) continue;
    out.push({ iso: d.toISOString(), source, explicitYear: true });
  }

  return out;
}

function latestIso(values: Array<string | null | undefined>): string | null {
  let latest: Date | null = null;
  for (const value of values) {
    const d = parseTimestamp(value);
    if (!d) continue;
    if (!latest || d.getTime() > latest.getTime()) latest = d;
  }
  return latest?.toISOString() ?? null;
}

function candidateAfter(
  candidates: DateCandidate[],
  threshold: Date | null
): DateCandidate | null {
  const thresholdMs = threshold ? threshold.getTime() + DAY_MS : -Infinity;
  let best: DateCandidate | null = null;
  for (const candidate of candidates) {
    const d = parseTimestamp(candidate.iso);
    if (!d || d.getTime() <= thresholdMs) continue;
    if (!best || d.getTime() > new Date(best.iso).getTime()) {
      best = candidate;
    }
  }
  return best;
}

function isAfter(a: string | null, b: string | null, slackDays = 1): boolean {
  const ad = parseTimestamp(a);
  const bd = parseTimestamp(b);
  if (!ad || !bd) return false;
  return ad.getTime() > bd.getTime() + slackDays * DAY_MS;
}

function hasLifecycleAfterRawEnd(market: GammaMarket, rawEnd: Date | null): boolean {
  if (!rawEnd) return false;
  const endMs = rawEnd.getTime();
  return [market.startDate, market.createdAt, market.acceptingOrdersTimestamp].some(
    (value) => {
      const d = parseTimestamp(value);
      return d != null && d.getTime() > endMs;
    }
  );
}

export function inferMarketTiming(
  market: GammaMarket,
  nowMs = Date.now()
): MarketTiming {
  const reasons: string[] = [];
  const rawEnd = parseTimestamp(market.endDate);
  const titleCandidates = [
    ...extractDateCandidates(market.question, "question", market, nowMs),
    ...extractDateCandidates(market.slug, "slug", market, nowMs),
    ...extractDateCandidates(
      market.events?.map((event) => event.title).join(" "),
      "question",
      market,
      nowMs
    ),
    ...extractDateCandidates(
      market.events?.map((event) => event.slug).join(" "),
      "slug",
      market,
      nowMs
    ),
  ];
  const descriptionCandidates = extractDateCandidates(
    market.description,
    "description",
    market,
    nowMs
  );

  const rawLifecycleStale = hasLifecycleAfterRawEnd(market, rawEnd);
  let eventDeadline = rawEnd?.toISOString() ?? null;
  let staleRawEndDate = rawLifecycleStale;
  let recurrentLike = rawLifecycleStale;
  let postponed = false;
  let confidence: TimingConfidence = rawEnd ? "high" : "low";

  if (rawLifecycleStale) {
    reasons.push("raw_end_before_market_lifecycle");
  }

  const gameStart = parseTimestamp(market.gameStartTime);
  if (market.sportsMarketType && gameStart && rawEnd && gameStart.getTime() > rawEnd.getTime() + DAY_MS) {
    eventDeadline = gameStart.toISOString();
    staleRawEndDate = true;
    postponed = true;
    confidence = "high";
    reasons.push("sports_rescheduled_from_game_start_time");
  } else {
    const titleAfterRaw = candidateAfter(titleCandidates, rawEnd);
    const descriptionAfterRaw = candidateAfter(descriptionCandidates, rawEnd);

    if (titleAfterRaw && (rawLifecycleStale || !rawEnd || rawEnd.getTime() < nowMs)) {
      eventDeadline = titleAfterRaw.iso;
      staleRawEndDate = rawEnd != null && isAfter(titleAfterRaw.iso, market.endDate);
      recurrentLike = rawLifecycleStale;
      confidence = "high";
      reasons.push(`event_deadline_from_${titleAfterRaw.source}`);
    } else if (!rawEnd && titleCandidates.length > 0) {
      eventDeadline = latestIso(titleCandidates.map((c) => c.iso));
      confidence = "medium";
      reasons.push("event_deadline_from_title_without_raw_end");
    } else if (rawLifecycleStale && descriptionAfterRaw) {
      eventDeadline = descriptionAfterRaw.iso;
      recurrentLike = true;
      confidence = "medium";
      reasons.push("event_deadline_from_description");
    }
  }

  const parsedResolution = parseResolutionDeadline(market.description, market.endDate);
  const resolutionDeadline =
    parsedResolution && isAfter(parsedResolution, eventDeadline)
      ? parsedResolution
      : null;
  const expectedPayoutDate = latestIso([
    eventDeadline,
    resolutionDeadline,
    market.endDate,
  ]);

  const eventEnd = parseTimestamp(eventDeadline);
  const resolutionEnd = parseTimestamp(resolutionDeadline);
  const eventExpired = eventEnd != null && eventEnd.getTime() < nowMs;
  const resolutionWindow =
    eventExpired && resolutionEnd != null && resolutionEnd.getTime() > nowMs;

  if (resolutionDeadline) reasons.push("resolution_deadline_later_than_event");
  if (staleRawEndDate && !reasons.includes("raw_end_before_market_lifecycle")) {
    reasons.push("raw_end_corrected");
  }
  if (recurrentLike) reasons.push("recurrent_or_rolled_market");
  if (postponed) reasons.push("postponed_or_rescheduled");

  const awaitingResolution =
    eventExpired &&
    market.acceptingOrders === true &&
    !postponed &&
    !resolutionWindow &&
    confidence !== "low";

  return {
    rawEndDate: market.endDate ?? null,
    eventDeadline,
    resolutionDeadline,
    expectedPayoutDate,
    staleRawEndDate,
    recurrentLike,
    postponed,
    awaitingResolution,
    confidence,
    reasons,
  };
}
