import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import path from "path";
import type { Fill, ModelOverlay, OfficialContext, Opportunity, PaperTrade, ScanRun } from "./types";

export type SqliteValue = string | number | bigint | null;

export interface StatementSync {
  all(...params: SqliteValue[]): Array<Record<string, unknown>>;
  get(...params: SqliteValue[]): Record<string, unknown> | undefined;
  run(...params: SqliteValue[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
}

interface SqliteModule {
  DatabaseSync: new (filename: string) => DatabaseSync;
}

let db: DatabaseSync | null = null;

function loadDatabaseSync() {
  const nodeProcess = process as typeof process & {
    getBuiltinModule?: (name: string) => unknown;
  };
  const sqlite = nodeProcess.getBuiltinModule?.("node:sqlite") as
    | SqliteModule
    | undefined;

  if (!sqlite?.DatabaseSync) {
    throw new Error(
      "Local SQLite storage requires a Node.js runtime with node:sqlite support."
    );
  }

  return sqlite.DatabaseSync;
}

function dbPath(): string {
  const configured = process.env.LOCAL_DB_PATH?.trim();
  if (!configured) {
    return path.join(
      /* turbopackIgnore: true */ process.cwd(),
      "data",
      "prededge.sqlite"
    );
  }
  if (configured === ":memory:") return configured;
  return path.isAbsolute(configured)
    ? configured
    : path.join(/* turbopackIgnore: true */ process.cwd(), configured);
}

function ensureDbDir(filename: string) {
  if (filename === ":memory:") return;
  mkdirSync(path.dirname(filename), { recursive: true });
}

export function getDb(): DatabaseSync {
  if (db) return db;

  const filename = dbPath();
  ensureDbDir(filename);
  const Database = loadDatabaseSync();
  db = new Database(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS scan_runs (
      scan_id TEXT PRIMARY KEY,
      markets_scanned INTEGER NOT NULL,
      candidates_found INTEGER NOT NULL,
      actionable_count INTEGER NOT NULL,
      observe_count INTEGER NOT NULL,
      rejected_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      question TEXT NOT NULL,
      event_slug TEXT NOT NULL,
      event_title TEXT,
      outcome TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      annualized_yield_pct REAL NOT NULL,
      net_return_pct REAL NOT NULL,
      days_to_expiry REAL NOT NULL,
      near_depth_usd REAL NOT NULL,
      slippage_bps REAL NOT NULL,
      stability_score REAL NOT NULL,
      decision TEXT NOT NULL,
      decision_reasons TEXT NOT NULL,
      volume_24hr REAL NOT NULL,
	      liquidity REAL NOT NULL,
	      market_url TEXT NOT NULL,
	      end_date TEXT,
	      event_deadline TEXT,
	      tags TEXT NOT NULL,
	      outcome_tokens TEXT NOT NULL,
	      asks TEXT NOT NULL,
	      awaiting_resolution INTEGER NOT NULL DEFAULT 0,
	      rewards_incentivized INTEGER NOT NULL DEFAULT 0,
	      neg_risk INTEGER NOT NULL DEFAULT 0,
	      uma_resolution_status TEXT,
	      oracle_resolution_state TEXT,
	      oracle_resolution_details TEXT,
	      resolved_by TEXT,
	      question_id TEXT,
	      resolution_deadline TEXT,
	      expected_payout_date TEXT,
	      stale_raw_end_date INTEGER NOT NULL DEFAULT 0,
	      recurrent_like INTEGER NOT NULL DEFAULT 0,
	      postponed INTEGER NOT NULL DEFAULT 0,
	      timing_confidence TEXT,
	      timing_reasons TEXT,
	      sports_market_type TEXT,
	      game_start_time TEXT,
	      model_overlay TEXT,
	      official_context TEXT,
	      taker_fee_rate REAL,
	      scanned_at TEXT NOT NULL,
      FOREIGN KEY (scan_id) REFERENCES scan_runs(scan_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS odds_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      condition_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      price REAL NOT NULL,
      captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS kv_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_trades (
      id TEXT PRIMARY KEY,
      condition_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      market_question TEXT NOT NULL,
      outcome_bought TEXT NOT NULL,
      market_url TEXT,
      end_date TEXT,
      usd_amount REAL NOT NULL,
      shares REAL NOT NULL,
      avg_fill_price REAL NOT NULL,
      worst_fill_price REAL NOT NULL,
      fills TEXT NOT NULL,
      status TEXT NOT NULL,
      resolved_outcome TEXT,
      pnl_usd REAL,
      pnl_pct REAL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_opportunities_scan
      ON opportunities (scan_id, scanned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_opportunities_scanned
      ON opportunities (scanned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_opportunities_decision
      ON opportunities (decision);
	    CREATE INDEX IF NOT EXISTS idx_paper_trades_status
	      ON paper_trades (status, created_at DESC);

    -- ===== Saylor BTC predictor tables =====
    CREATE TABLE IF NOT EXISTS mstr_weekly_history (
      week_idx INTEGER PRIMARY KEY,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      outcome TEXT NOT NULL,
      open_price REAL,
      close_price REAL,
      min_price REAL,
      max_price REAL,
      avg_price REAL,
      volume_usd REAL,
      category TEXT,
      condition_id TEXT,
      yes_token_id TEXT,
      slug TEXT,
      title TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mstr_weekly_start
      ON mstr_weekly_history (start_date);

    CREATE TABLE IF NOT EXISTS saylor_tweets (
      id TEXT PRIMARY KEY,
      posted_at TEXT NOT NULL,
      text TEXT NOT NULL,
      url TEXT,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saylor_tweets_posted
      ON saylor_tweets (posted_at DESC);

    CREATE TABLE IF NOT EXISTS saylor_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      matched_phrase TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (tweet_id) REFERENCES saylor_tweets(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_saylor_signals_week
      ON saylor_signals (week_start);

    CREATE TABLE IF NOT EXISTS saylor_capital_actions (
      week_start TEXT PRIMARY KEY,
      flagged INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      flagged_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saylor_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      probability REAL NOT NULL,
      recommendation TEXT NOT NULL,
      signal_breakdown TEXT NOT NULL,
      polymarket_yes_price REAL,
      polymarket_condition_id TEXT,
      computed_at TEXT NOT NULL,
      UNIQUE (week_start, computed_at)
    );
    CREATE INDEX IF NOT EXISTS idx_saylor_predictions_week
      ON saylor_predictions (week_start DESC);
	  `);

  ensureOpportunityColumns(db);
  ensurePaperTradeColumns(db);

  return db;
}

/** paper_trades 后加列(2026-07-19 审查 §11):dir_method 与三闸门快照。8 月
 * 预告家族 go/no-go 需要按 dirMethod/闸门结果分层,登记时不留痕就只能事后
 * 用裸均值糊(决策失真)。 */
function ensurePaperTradeColumns(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(paper_trades)").all();
  const existing = new Set(rows.map((row) => String(row.name)));
  const columns: Array<[string, string]> = [
    ["dir_method", "dir_method TEXT"],
    ["gate_meta", "gate_meta TEXT"],
  ];
  for (const [name, ddl] of columns) {
    if (!existing.has(name)) {
      database.exec(`ALTER TABLE paper_trades ADD COLUMN ${ddl}`);
    }
  }
}

function ensureOpportunityColumns(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(opportunities)").all();
  const existing = new Set(rows.map((row) => String(row.name)));
  const columns: Array<[string, string]> = [
    ["event_deadline", "event_deadline TEXT"],
    ["expected_payout_date", "expected_payout_date TEXT"],
    ["stale_raw_end_date", "stale_raw_end_date INTEGER NOT NULL DEFAULT 0"],
    ["recurrent_like", "recurrent_like INTEGER NOT NULL DEFAULT 0"],
    ["postponed", "postponed INTEGER NOT NULL DEFAULT 0"],
    ["timing_confidence", "timing_confidence TEXT"],
    ["timing_reasons", "timing_reasons TEXT"],
    ["oracle_resolution_state", "oracle_resolution_state TEXT"],
    ["oracle_resolution_details", "oracle_resolution_details TEXT"],
    ["resolved_by", "resolved_by TEXT"],
    ["question_id", "question_id TEXT"],
    ["model_overlay", "model_overlay TEXT"],
    ["official_context", "official_context TEXT"],
    ["taker_fee_rate", "taker_fee_rate REAL"],
  ];

  for (const [name, ddl] of columns) {
    if (!existing.has(name)) {
      database.exec(`ALTER TABLE opportunities ADD COLUMN ${ddl}`);
    }
  }
}

function withTransaction<T>(fn: (database: DatabaseSync) => T): T {
  const database = getDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(database);
    database.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The original error is more useful.
    }
    throw err;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function boolToInt(value: unknown): number {
  return value ? 1 : 0;
}

function intToBool(value: unknown): boolean {
  return Number(value) === 1;
}

function scanRunFromRow(row: Record<string, unknown>): ScanRun {
  return {
    scanId: String(row.scan_id),
    marketsScanned: Number(row.markets_scanned),
    candidatesFound: Number(row.candidates_found),
    actionableCount: Number(row.actionable_count),
    observeCount: Number(row.observe_count),
    rejectedCount: Number(row.rejected_count),
    durationMs: Number(row.duration_ms),
    startedAt: String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

function opportunityFromRow(row: Record<string, unknown>): Opportunity {
  return {
    conditionId: String(row.condition_id),
    tokenId: String(row.token_id),
    question: String(row.question),
    eventSlug: String(row.event_slug),
    eventTitle: row.event_title == null ? null : String(row.event_title),
    outcome: String(row.outcome),
    side: ((row.side as string) || "BUY") as "BUY" | "SELL",
    price: Number(row.price),
    annualizedYieldPct: Number(row.annualized_yield_pct),
    netReturnPct: Number(row.net_return_pct),
    daysToExpiry: Number(row.days_to_expiry),
    nearDepthUsd: Number(row.near_depth_usd),
    slippageBps: Number(row.slippage_bps),
    stabilityScore: Number(row.stability_score),
    decision: row.decision as "actionable" | "observe" | "rejected",
    decisionReasons: fromJson<string[]>(row.decision_reasons, []),
    volume24hr: Number(row.volume_24hr),
	    liquidity: Number(row.liquidity),
	    marketUrl: String(row.market_url),
	    endDate: row.end_date == null ? null : String(row.end_date),
	    eventDeadline:
	      row.event_deadline == null ? null : String(row.event_deadline),
	    tags: fromJson<string[]>(row.tags, []),
	    outcomeTokens: fromJson<Record<string, string>>(row.outcome_tokens, {}),
	    asks: fromJson<Array<{ price: number; size: number }>>(row.asks, []),
	    awaitingResolution: intToBool(row.awaiting_resolution),
	    staleRawEndDate: intToBool(row.stale_raw_end_date),
	    recurrentLike: intToBool(row.recurrent_like),
	    postponed: intToBool(row.postponed),
	    rewardsIncentivized: intToBool(row.rewards_incentivized),
	    negRisk: intToBool(row.neg_risk),
	    umaResolutionStatus:
	      row.uma_resolution_status == null ? null : String(row.uma_resolution_status),
	    oracleResolutionState:
	      row.oracle_resolution_state == null
	        ? null
	        : (String(row.oracle_resolution_state) as Opportunity["oracleResolutionState"]),
	    oracleResolutionDetails:
	      row.oracle_resolution_details == null
	        ? null
	        : String(row.oracle_resolution_details),
	    resolvedBy: row.resolved_by == null ? null : String(row.resolved_by),
	    questionID: row.question_id == null ? null : String(row.question_id),
	    resolutionDeadline:
	      row.resolution_deadline == null ? null : String(row.resolution_deadline),
	    expectedPayoutDate:
	      row.expected_payout_date == null ? null : String(row.expected_payout_date),
	    timingConfidence:
	      row.timing_confidence == null
	        ? undefined
	        : (String(row.timing_confidence) as "high" | "medium" | "low"),
	    timingReasons: fromJson<string[]>(row.timing_reasons, []),
	    sportsMarketType:
	      row.sports_market_type == null ? null : String(row.sports_market_type),
    gameStartTime: row.game_start_time == null ? null : String(row.game_start_time),
    modelOverlay: fromJson<ModelOverlay | null>(row.model_overlay, null),
    officialContext: fromJson<OfficialContext | null>(row.official_context, null),
    takerFeeRate: row.taker_fee_rate == null ? null : Number(row.taker_fee_rate),
  };
}

function opportunityRowForApi(row: Record<string, unknown>) {
  return {
    ...row,
    decision_reasons: fromJson<string[]>(row.decision_reasons, []),
    tags: fromJson<string[]>(row.tags, []),
    outcome_tokens: fromJson<Record<string, string>>(row.outcome_tokens, {}),
    asks: fromJson<Array<{ price: number; size: number }>>(row.asks, []),
	    awaiting_resolution: intToBool(row.awaiting_resolution),
	    rewards_incentivized: intToBool(row.rewards_incentivized),
	    neg_risk: intToBool(row.neg_risk),
	    oracle_resolution_state:
	      row.oracle_resolution_state == null ? null : String(row.oracle_resolution_state),
	    oracle_resolution_details:
	      row.oracle_resolution_details == null ? null : String(row.oracle_resolution_details),
	    stale_raw_end_date: intToBool(row.stale_raw_end_date),
	    recurrent_like: intToBool(row.recurrent_like),
	    postponed: intToBool(row.postponed),
	    timing_reasons: fromJson<string[]>(row.timing_reasons, []),
	    model_overlay: fromJson<ModelOverlay | null>(row.model_overlay, null),
	    official_context: fromJson<OfficialContext | null>(row.official_context, null),
	  };
	}

function paperTradeFromRow(row: Record<string, unknown>): PaperTrade {
  return {
    id: String(row.id),
    conditionId: String(row.condition_id),
    tokenId: String(row.token_id),
    marketQuestion: String(row.market_question),
    outcomeBought: String(row.outcome_bought),
    marketUrl: row.market_url == null ? null : String(row.market_url),
    endDate: row.end_date == null ? null : String(row.end_date),
    usdAmount: Number(row.usd_amount),
    shares: Number(row.shares),
    avgFillPrice: Number(row.avg_fill_price),
    worstFillPrice: Number(row.worst_fill_price),
    fills: fromJson<Fill[]>(row.fills, []),
    status: row.status as PaperTrade["status"],
    resolvedOutcome:
      row.resolved_outcome == null ? null : String(row.resolved_outcome),
    pnlUsd: row.pnl_usd == null ? null : Number(row.pnl_usd),
    pnlPct: row.pnl_pct == null ? null : Number(row.pnl_pct),
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
    dirMethod: row.dir_method == null ? null : String(row.dir_method),
    gateMeta: fromJson<Record<string, unknown> | null>(row.gate_meta, null),
  };
}

/** Days of scan history to keep. opportunities follows scan_runs via ON
 * DELETE CASCADE (PRAGMA foreign_keys=ON at init); odds_snapshots is trimmed
 * on the same horizon. Without this the two tables are append-only and the
 * sqlite file grows by hundreds of rows per scan, forever. */
const SCAN_RETENTION_DAYS = 30;

export function persistScanResult(scan: ScanRun, opportunities: Opportunity[]) {
  withTransaction((database) => {
    database
      .prepare(
        `INSERT INTO scan_runs (
          scan_id, markets_scanned, candidates_found, actionable_count,
          observe_count, rejected_count, duration_ms, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        scan.scanId,
        scan.marketsScanned,
        scan.candidatesFound,
        scan.actionableCount,
        scan.observeCount,
        scan.rejectedCount,
        scan.durationMs,
        scan.startedAt,
        scan.completedAt
      );

    const retentionCutoff = new Date(
      Date.now() - SCAN_RETENTION_DAYS * 86_400_000
    ).toISOString();
    database
      .prepare(`DELETE FROM scan_runs WHERE started_at < ?`)
      .run(retentionCutoff);
    database
      .prepare(`DELETE FROM odds_snapshots WHERE captured_at < ?`)
      .run(retentionCutoff);

    if (opportunities.length === 0) return;

    const scannedAt = scan.completedAt ?? nowIso();
    const insertOpportunity = database.prepare(
      `INSERT INTO opportunities (
        scan_id, condition_id, token_id, question, event_slug, event_title,
	        outcome, side, price, annualized_yield_pct, net_return_pct,
	        days_to_expiry, near_depth_usd, slippage_bps, stability_score,
	        decision, decision_reasons, volume_24hr, liquidity, market_url,
	        end_date, event_deadline, tags, outcome_tokens, asks, awaiting_resolution,
	        rewards_incentivized, neg_risk, uma_resolution_status,
	        oracle_resolution_state, oracle_resolution_details, resolved_by,
	        question_id, resolution_deadline, expected_payout_date,
	        stale_raw_end_date, recurrent_like, postponed, timing_confidence,
	        timing_reasons, sports_market_type, game_start_time, model_overlay,
	        official_context, taker_fee_rate, scanned_at
	      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertSnapshot = database.prepare(
      `INSERT INTO odds_snapshots (condition_id, token_id, outcome, price)
       VALUES (?, ?, ?, ?)`
    );

    for (const opp of opportunities) {
      insertOpportunity.run(
        scan.scanId,
        opp.conditionId,
        opp.tokenId,
        opp.question,
        opp.eventSlug,
        opp.eventTitle,
        opp.outcome,
        opp.side,
        opp.price,
        opp.annualizedYieldPct,
        opp.netReturnPct,
        opp.daysToExpiry,
        opp.nearDepthUsd,
        opp.slippageBps,
        opp.stabilityScore,
        opp.decision,
        toJson(opp.decisionReasons),
	        opp.volume24hr,
	        opp.liquidity,
	        opp.marketUrl,
	        opp.endDate ?? null,
	        opp.eventDeadline ?? null,
	        toJson(opp.tags),
	        toJson(opp.outcomeTokens),
	        toJson(opp.asks),
        boolToInt(opp.awaitingResolution),
        boolToInt(opp.rewardsIncentivized),
	        boolToInt(opp.negRisk),
	        opp.umaResolutionStatus ?? null,
	        opp.oracleResolutionState ?? null,
	        opp.oracleResolutionDetails ?? null,
	        opp.resolvedBy ?? null,
	        opp.questionID ?? null,
	        opp.resolutionDeadline ?? null,
	        opp.expectedPayoutDate ?? null,
	        boolToInt(opp.staleRawEndDate),
	        boolToInt(opp.recurrentLike),
	        boolToInt(opp.postponed),
	        opp.timingConfidence ?? null,
	        toJson(opp.timingReasons ?? []),
	        opp.sportsMarketType ?? null,
        opp.gameStartTime ?? null,
        toJson(opp.modelOverlay ?? null),
        toJson(opp.officialContext ?? null),
        opp.takerFeeRate ?? null,
        scannedAt
      );
      insertSnapshot.run(opp.conditionId, opp.tokenId, opp.outcome, opp.price);
    }
  });
}

export function getLatestScanRun(): ScanRun | null {
  const row = getDb()
    .prepare("SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 1")
    .get();
  return row ? scanRunFromRow(row) : null;
}

export function listOpportunitiesForScan(
  scanId: string,
  filters: { decision?: string; maxDays?: number }
): Opportunity[] {
  const where = ["scan_id = ?"];
  const params: SqliteValue[] = [scanId];

  if (filters.decision && filters.decision !== "all") {
    where.push("decision = ?");
    params.push(filters.decision);
  }
  if (Number.isFinite(filters.maxDays)) {
    where.push("days_to_expiry <= ?");
    params.push(filters.maxDays as number);
  }

  const rows = getDb()
    .prepare(
      `SELECT * FROM opportunities
       WHERE ${where.join(" AND ")}
       ORDER BY scanned_at DESC`
    )
    .all(...params);

  return rows.map(opportunityFromRow);
}

export function listOpportunityRows(options: {
  decision?: string;
  minYield?: number;
  limit: number;
  offset: number;
}) {
  const where: string[] = [];
  const params: SqliteValue[] = [];

  if (options.decision && options.decision !== "all") {
    where.push("decision = ?");
    params.push(options.decision);
  }
  if (Number.isFinite(options.minYield)) {
    where.push("annualized_yield_pct >= ?");
    params.push(options.minYield as number);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const database = getDb();
  const countRow = database
    .prepare(`SELECT COUNT(*) AS count FROM opportunities ${whereSql}`)
    .get(...params);
  const rows = database
    .prepare(
      `SELECT * FROM opportunities
       ${whereSql}
       ORDER BY scanned_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, options.limit, options.offset);

  return {
    data: rows.map(opportunityRowForApi),
    total: Number(countRow?.count ?? 0),
  };
}

export function listPaperTrades(status: string): PaperTrade[] {
  const database = getDb();
  let sql = "SELECT * FROM paper_trades";
  const params: SqliteValue[] = [];

  if (status === "open") {
    sql += " WHERE status = ?";
    params.push("open");
  } else if (status === "resolved") {
    sql += " WHERE status IN (?, ?, ?)";
    params.push("won", "lost", "void");
  }

  sql += " ORDER BY created_at DESC";
  return database.prepare(sql).all(...params).map(paperTradeFromRow);
}

export function listOpenPaperTrades(): PaperTrade[] {
  return listPaperTrades("open");
}

export function insertPaperTrade(input: {
  conditionId: string;
  tokenId: string;
  marketQuestion: string;
  outcomeBought: string;
  marketUrl: string | null;
  endDate: string | null;
  usdAmount: number;
  shares: number;
  avgFillPrice: number;
  worstFillPrice: number;
  fills: Fill[];
  /** execCheck 方向映射方法(2026-07-19 审查 §11:事后按映射可信度分层)。 */
  dirMethod?: string | null;
  /** 登记时刻的闸门/判读快照(JSON;预告家族 8 月 go/no-go 按此分层)。 */
  gateMeta?: Record<string, unknown> | null;
}): PaperTrade {
  const id = randomUUID();
  const createdAt = nowIso();

  getDb()
    .prepare(
      `INSERT INTO paper_trades (
        id, condition_id, token_id, market_question, outcome_bought,
        market_url, end_date, usd_amount, shares, avg_fill_price,
        worst_fill_price, fills, status, created_at, dir_method, gate_meta
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.conditionId,
      input.tokenId,
      input.marketQuestion,
      input.outcomeBought,
      input.marketUrl,
      input.endDate,
      input.usdAmount,
      input.shares,
      input.avgFillPrice,
      input.worstFillPrice,
      toJson(input.fills),
      "open",
      createdAt,
      input.dirMethod ?? null,
      input.gateMeta == null ? null : toJson(input.gateMeta)
    );

  return {
    id,
    conditionId: input.conditionId,
    tokenId: input.tokenId,
    marketQuestion: input.marketQuestion,
    outcomeBought: input.outcomeBought,
    marketUrl: input.marketUrl,
    endDate: input.endDate,
    usdAmount: input.usdAmount,
    shares: input.shares,
    avgFillPrice: input.avgFillPrice,
    worstFillPrice: input.worstFillPrice,
    fills: input.fills,
    status: "open",
    resolvedOutcome: null,
    pnlUsd: null,
    pnlPct: null,
    createdAt,
    resolvedAt: null,
    dirMethod: input.dirMethod ?? null,
    gateMeta: input.gateMeta ?? null,
  };
}

// ── Generic key-value state (e.g. on-chain event sweep cursor) ──

export function getKvState(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM kv_state WHERE key = ?")
    .get(key);
  return row ? String(row.value) : null;
}

export function setKvState(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO kv_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, new Date().toISOString());
}

export function updatePaperTradeResolution(
  id: string,
  update: {
    status: "won" | "lost" | "void";
    resolvedOutcome: string | null;
    pnlUsd: number;
    pnlPct: number;
    resolvedAt: string;
  }
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE paper_trades
       SET status = ?,
           resolved_outcome = ?,
           pnl_usd = ?,
           pnl_pct = ?,
           resolved_at = ?
       WHERE id = ?`
    )
    .run(
      update.status,
      update.resolvedOutcome,
      update.pnlUsd,
      update.pnlPct,
      update.resolvedAt,
      id
    );

  return result.changes > 0;
}
