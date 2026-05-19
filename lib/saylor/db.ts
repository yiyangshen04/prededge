/**
 * SQLite layer for Saylor predictor.
 *
 * Reuses the shared `getDb()` handle from `lib/localDb.ts` so all tables
 * live in the same database file under WAL with foreign-key enforcement.
 * The Saylor schema is appended to the canonical `db.exec()` block in
 * `lib/localDb.ts` — opening the handle here triggers that initialization.
 */

import { getDb } from "../localDb";
import type { SqliteValue } from "../localDb";
import { mondayOf } from "./calendar";
import { classifyTweet } from "./classifier";
import { SEED_TWEETS } from "./seedTweets";
import type {
  CapitalActionFlag,
  SaylorTweet,
  SignalHit,
  SignalType,
  WeekPrediction,
  WeekRecord,
} from "./types";

// ── Row mappers ────────────────────────────────────────────────────────────

function weekRecordFromRow(row: Record<string, unknown>): WeekRecord {
  return {
    weekIdx: Number(row.week_idx),
    startDate: String(row.start_date),
    endDate: String(row.end_date),
    outcome: String(row.outcome) as WeekRecord["outcome"],
    openPrice: row.open_price == null ? null : Number(row.open_price),
    closePrice: row.close_price == null ? null : Number(row.close_price),
    minPrice: row.min_price == null ? null : Number(row.min_price),
    maxPrice: row.max_price == null ? null : Number(row.max_price),
    avgPrice: row.avg_price == null ? null : Number(row.avg_price),
    volumeUsd: row.volume_usd == null ? null : Number(row.volume_usd),
    category: row.category == null ? null : String(row.category),
    conditionId: row.condition_id == null ? null : String(row.condition_id),
    yesTokenId: row.yes_token_id == null ? null : String(row.yes_token_id),
    slug: row.slug == null ? null : String(row.slug),
    title: row.title == null ? null : String(row.title),
  };
}

function tweetFromRow(row: Record<string, unknown>): SaylorTweet {
  return {
    id: String(row.id),
    postedAt: String(row.posted_at),
    text: String(row.text),
    url: row.url == null ? null : String(row.url),
    source: String(row.source) as SaylorTweet["source"],
    fetchedAt: String(row.fetched_at),
  };
}

function signalFromRow(row: Record<string, unknown>): SignalHit {
  return {
    type: String(row.signal_type) as SignalType,
    matchedPhrase: String(row.matched_phrase),
    weight: Number(row.confidence),
    tweetId: row.tweet_id == null ? null : String(row.tweet_id),
  };
}

function capitalActionFromRow(
  row: Record<string, unknown>
): CapitalActionFlag {
  return {
    weekStart: String(row.week_start),
    flagged: Number(row.flagged) === 1,
    note: row.note == null ? null : String(row.note),
    flaggedAt: String(row.flagged_at),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

// History rows
export function upsertWeek(row: WeekRecord): void {
  getDb()
    .prepare(
      `INSERT INTO mstr_weekly_history (
        week_idx, start_date, end_date, outcome,
        open_price, close_price, min_price, max_price, avg_price,
        volume_usd, category, condition_id, yes_token_id, slug, title
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(week_idx) DO UPDATE SET
        start_date=excluded.start_date,
        end_date=excluded.end_date,
        outcome=excluded.outcome,
        open_price=excluded.open_price,
        close_price=excluded.close_price,
        min_price=excluded.min_price,
        max_price=excluded.max_price,
        avg_price=excluded.avg_price,
        volume_usd=excluded.volume_usd,
        category=excluded.category,
        condition_id=excluded.condition_id,
        yes_token_id=excluded.yes_token_id,
        slug=excluded.slug,
        title=excluded.title`
    )
    .run(
      row.weekIdx,
      row.startDate,
      row.endDate,
      row.outcome,
      row.openPrice,
      row.closePrice,
      row.minPrice,
      row.maxPrice,
      row.avgPrice,
      row.volumeUsd,
      row.category,
      row.conditionId,
      row.yesTokenId,
      row.slug,
      row.title
    );
}

export function listWeeks(options: {
  limit?: number;
  offset?: number;
}): { weeks: WeekRecord[]; total: number } {
  const database = getDb();
  const limit = options.limit ?? 200;
  const offset = options.offset ?? 0;
  const countRow = database
    .prepare("SELECT COUNT(*) AS c FROM mstr_weekly_history")
    .get();
  const rows = database
    .prepare(
      `SELECT * FROM mstr_weekly_history
       ORDER BY start_date DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  return {
    weeks: rows.map(weekRecordFromRow),
    total: Number(countRow?.c ?? 0),
  };
}

export function getWeekByStartDate(weekStart: string): WeekRecord | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM mstr_weekly_history WHERE start_date = ? LIMIT 1"
    )
    .get(weekStart);
  return row ? weekRecordFromRow(row) : null;
}

/** Find the previous week's record by start date (strict <). */
export function getPrevWeek(weekStart: string): WeekRecord | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM mstr_weekly_history
       WHERE start_date < ?
       ORDER BY start_date DESC
       LIMIT 1`
    )
    .get(weekStart);
  return row ? weekRecordFromRow(row) : null;
}

// Tweets
export function upsertTweet(t: SaylorTweet): { inserted: boolean } {
  const result = getDb()
    .prepare(
      `INSERT INTO saylor_tweets (id, posted_at, text, url, source, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         posted_at=excluded.posted_at,
         text=excluded.text,
         url=excluded.url,
         source=excluded.source,
         fetched_at=excluded.fetched_at`
    )
    .run(t.id, t.postedAt, t.text, t.url, t.source, t.fetchedAt);
  return { inserted: result.changes > 0 };
}

export function listTweets(opts: {
  sinceIso?: string;
  limit?: number;
}): SaylorTweet[] {
  const limit = opts.limit ?? 50;
  const where: string[] = [];
  const params: SqliteValue[] = [];
  if (opts.sinceIso) {
    where.push("posted_at >= ?");
    params.push(opts.sinceIso);
  }
  const sql = `SELECT * FROM saylor_tweets ${
    where.length ? `WHERE ${where.join(" AND ")}` : ""
  } ORDER BY posted_at DESC LIMIT ?`;
  return getDb()
    .prepare(sql)
    .all(...params, limit)
    .map(tweetFromRow);
}

export function latestTweetTimestamp(): string | null {
  const row = getDb()
    .prepare(
      "SELECT posted_at FROM saylor_tweets ORDER BY posted_at DESC LIMIT 1"
    )
    .get();
  return row ? String(row.posted_at) : null;
}

export function countTweets(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS c FROM saylor_tweets").get();
  return Number(row?.c ?? 0);
}

/**
 * Seed the tweets + signals tables from the committed snapshot on first use.
 *
 * The Saylor predictor is useless without tweets to classify, and the live X
 * Syndication endpoint is almost always rate-limited from a datacenter IP, so
 * on Vercel the DB would otherwise stay empty (and the gauge stuck at the
 * "no signals → 50%" default). This loads ~120 real recent tweets, classifies
 * each, and buckets the resulting signals into their actual posting week.
 *
 * Idempotent and cheap: it no-ops once any tweet exists, so it runs at most
 * once per cold-started serverless instance (the SQLite file lives in /tmp and
 * is recreated on each cold start). Fresh tweets from refresh / manual paste
 * layer on top and are never overwritten.
 */
export function ensureSeeded(): void {
  if (countTweets() > 0) return;
  for (const seed of SEED_TWEETS) {
    const tweet: SaylorTweet = {
      id: seed.id,
      postedAt: seed.postedAt,
      text: seed.text,
      url: seed.url,
      source: "syndication",
      fetchedAt: seed.postedAt,
    };
    upsertTweet(tweet);
    const hits = classifyTweet(tweet.text, tweet.id);
    if (hits.length > 0) {
      saveSignals(hits, mondayOf(new Date(tweet.postedAt)));
    }
  }
}

// Signals
export function saveSignals(hits: SignalHit[], weekStart: string): void {
  if (hits.length === 0) return;
  const now = nowIso();
  const stmt = getDb().prepare(
    `INSERT INTO saylor_signals (tweet_id, week_start, signal_type, matched_phrase, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const h of hits) {
    if (!h.tweetId) continue; // skip 8-K placeholder hits without a tweet
    stmt.run(
      h.tweetId,
      weekStart,
      h.type,
      h.matchedPhrase,
      h.weight,
      now
    );
  }
}

export function listSignalsForWeek(weekStart: string): SignalHit[] {
  return getDb()
    .prepare(
      `SELECT * FROM saylor_signals WHERE week_start = ? ORDER BY created_at DESC`
    )
    .all(weekStart)
    .map(signalFromRow);
}

/**
 * Most recent week (Monday ISO date) that has at least one classified signal,
 * or null if none. Used to fall back to the latest week with Saylor activity
 * when the current week is still silent.
 */
export function latestSignalWeek(): string | null {
  const row = getDb()
    .prepare(
      `SELECT week_start FROM saylor_signals ORDER BY week_start DESC LIMIT 1`
    )
    .get();
  return row ? String(row.week_start) : null;
}

// Capital actions
export function setCapitalActionFlag(input: {
  weekStart: string;
  flagged: boolean;
  note?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO saylor_capital_actions (week_start, flagged, note, flagged_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(week_start) DO UPDATE SET
         flagged=excluded.flagged,
         note=excluded.note,
         flagged_at=excluded.flagged_at`
    )
    .run(
      input.weekStart,
      input.flagged ? 1 : 0,
      input.note ?? null,
      nowIso()
    );
}

export function getCapitalActionFlag(weekStart: string): CapitalActionFlag | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM saylor_capital_actions WHERE week_start = ? LIMIT 1`
    )
    .get(weekStart);
  return row ? capitalActionFromRow(row) : null;
}

// Predictions
export function savePrediction(
  p: WeekPrediction,
  polymarket: { yesPrice: number | null; conditionId: string | null }
): void {
  getDb()
    .prepare(
      `INSERT INTO saylor_predictions (
        week_start, week_end, probability, recommendation,
        signal_breakdown, polymarket_yes_price, polymarket_condition_id, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(week_start, computed_at) DO NOTHING`
    )
    .run(
      p.weekStart,
      p.weekEnd,
      p.probability,
      p.recommendation,
      JSON.stringify({ breakdown: p.breakdown, flags: p.flags, reason: p.reason }),
      polymarket.yesPrice,
      polymarket.conditionId,
      nowIso()
    );
}

export interface StoredPrediction {
  weekStart: string;
  weekEnd: string;
  probability: number;
  recommendation: string;
  signalBreakdown: string; // raw JSON
  polymarketYesPrice: number | null;
  polymarketConditionId: string | null;
  computedAt: string;
}

function storedPredictionFromRow(
  row: Record<string, unknown>
): StoredPrediction {
  return {
    weekStart: String(row.week_start),
    weekEnd: String(row.week_end),
    probability: Number(row.probability),
    recommendation: String(row.recommendation),
    signalBreakdown: String(row.signal_breakdown),
    polymarketYesPrice:
      row.polymarket_yes_price == null
        ? null
        : Number(row.polymarket_yes_price),
    polymarketConditionId:
      row.polymarket_condition_id == null
        ? null
        : String(row.polymarket_condition_id),
    computedAt: String(row.computed_at),
  };
}

export function getLatestPrediction(weekStart: string): StoredPrediction | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM saylor_predictions
       WHERE week_start = ?
       ORDER BY computed_at DESC
       LIMIT 1`
    )
    .get(weekStart);
  return row ? storedPredictionFromRow(row) : null;
}

export function listPredictions(limit: number = 200): StoredPrediction[] {
  return getDb()
    .prepare(
      `SELECT * FROM saylor_predictions
       ORDER BY week_start DESC, computed_at DESC
       LIMIT ?`
    )
    .all(limit)
    .map(storedPredictionFromRow);
}
