/**
 * Polymarket market discovery for "Will MicroStrategy buy bitcoin this week"
 * series. Reuses the existing PolymarketClient for HTTP + retries.
 */

import { PolymarketClient } from "../polymarket/client";
import { DEFAULT_SCAN_CONFIG, GAMMA_API } from "../polymarket/config";
import type { GammaMarket } from "../types";
import type { CurrentMarket } from "./types";
import { mondayOf } from "./calendar";

const MSTR_QUESTION_RE =
  /will\s+(?:microstrategy|strategy)\s+(?:purchase|buy)\s+(?:more\s+)?bitcoin/i;

const SEARCH_QUERIES = [
  "microstrategy bitcoin",
  "strategy bitcoin week",
] as const;

function isWeeklyMstrMarket(m: GammaMarket): boolean {
  if (!m.question) return false;
  if (!MSTR_QUESTION_RE.test(m.question)) return false;
  // Exclude annual / general "will MicroStrategy hold X BTC by 2027" markets.
  if (/\b(2026|2027|2028|2029|2030|by\s+the\s+end)\b/i.test(m.question)) {
    // Allow if it also names a week range.
    if (
      !/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(m.question)
    ) {
      return false;
    }
  }
  return true;
}

async function searchMarkets(
  client: PolymarketClient,
  query: string
): Promise<GammaMarket[]> {
  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    limit: "50",
    q: query,
  });
  type FetchJson = (url: string) => Promise<unknown>;
  // The HTTP layer is private; we instead call fetchMarketsPage with
  // an order that biases toward fresh markets and filter client-side.
  // The Gamma `q` param isn't part of `fetchMarketsPage` — call directly.
  const res = await fetch(`${GAMMA_API}/markets?${params.toString()}`, {
    headers: { Accept: "application/json", "User-Agent": "prededge-saylor/1.0" },
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const data = (await res.json().catch(() => null)) as
    | GammaMarket[]
    | null;
  if (!Array.isArray(data)) return [];
  void ({} as FetchJson); // suppress unused
  return data;
}

/**
 * Find the live MSTR weekly market that resolves *this* week (the Monday
 * containing `now`). Returns null if no matching market is open.
 */
export async function findCurrentMSTRWeeklyMarket(
  now: Date = new Date()
): Promise<CurrentMarket | null> {
  const client = new PolymarketClient(DEFAULT_SCAN_CONFIG);
  const thisMonday = mondayOf(now);

  const seen = new Map<string, GammaMarket>();
  for (const q of SEARCH_QUERIES) {
    const found = await searchMarkets(client, q);
    for (const m of found) {
      if (!m.conditionId) continue;
      if (!isWeeklyMstrMarket(m)) continue;
      if (!seen.has(m.conditionId)) seen.set(m.conditionId, m);
    }
  }

  if (seen.size === 0) return null;

  // Choose the market whose endDate is closest to this Monday's end-of-week.
  const targetEnd = new Date(thisMonday);
  targetEnd.setUTCDate(targetEnd.getUTCDate() + 6); // Sunday
  const targetEndMs = targetEnd.getTime();

  let best: GammaMarket | null = null;
  let bestDelta = Infinity;
  for (const m of seen.values()) {
    if (!m.endDate) continue;
    const t = new Date(m.endDate).getTime();
    if (!Number.isFinite(t)) continue;
    const delta = Math.abs(t - targetEndMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = m;
    }
  }
  if (!best) return null;

  // Resolve YES token id and live price.
  const tokens = parseClobTokens(best);
  const yesTokenId = tokens.yes ?? null;
  const yesPrice = yesTokenId
    ? await client.fetchPrice(yesTokenId, "BUY").catch(() => null)
    : null;
  const noPrice =
    tokens.no != null
      ? await client.fetchPrice(tokens.no, "BUY").catch(() => null)
      : null;

  return {
    conditionId: best.conditionId,
    yesTokenId: yesTokenId ?? "",
    yesPrice,
    noPrice,
    question: best.question ?? "",
    slug: best.slug ?? "",
    endDate: best.endDate ?? null,
    marketUrl: best.slug
      ? `https://polymarket.com/event/${best.slug}`
      : "https://polymarket.com",
    fetchedAt: new Date().toISOString(),
  };
}

function parseClobTokens(m: GammaMarket): { yes: string | null; no: string | null } {
  const rawTokens = (m.clobTokenIds ?? null) as unknown;
  const rawOutcomes = (m.outcomes ?? null) as unknown;

  let tokens: string[] = [];
  let outcomes: string[] = [];

  if (typeof rawTokens === "string") {
    try {
      const parsed = JSON.parse(rawTokens);
      if (Array.isArray(parsed)) tokens = parsed.map(String);
    } catch {
      // ignore
    }
  } else if (Array.isArray(rawTokens)) {
    tokens = rawTokens.map(String);
  }

  if (typeof rawOutcomes === "string") {
    try {
      const parsed = JSON.parse(rawOutcomes);
      if (Array.isArray(parsed)) outcomes = parsed.map(String);
    } catch {
      // ignore
    }
  } else if (Array.isArray(rawOutcomes)) {
    outcomes = rawOutcomes.map(String);
  }

  let yes: string | null = null;
  let no: string | null = null;
  for (let i = 0; i < outcomes.length && i < tokens.length; i++) {
    if (/yes/i.test(outcomes[i])) yes = tokens[i];
    else if (/no/i.test(outcomes[i])) no = tokens[i];
  }
  // Fallback if outcomes is empty: assume index 0 = yes.
  if (!yes && tokens[0]) yes = tokens[0];
  if (!no && tokens[1]) no = tokens[1];
  return { yes, no };
}
