import type { GammaMarket, OrderBook, EventTag, ScanConfig } from "../types";
import { GAMMA_API, CLOB_API } from "./config";

const eventTagCache = new Map<string, EventTag[]>();

/** True when the Gamma status-history field records a dispute. Accepts the
 * raw field shape (JSON-encoded string or array). */
function statusesHistoryHasDisputed(
  raw: string | string[] | null | undefined
): boolean {
  let list: string[];
  if (Array.isArray(raw)) {
    list = raw.map(String);
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      list = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      list = [];
    }
  } else {
    list = [];
  }
  return list.some((s) => s.trim().toLowerCase() === "disputed");
}

/** Gamma's server-side page size cap: `limit` values above this are silently
 * clamped, so pagination must stride by it or it terminates early. */
const GAMMA_PAGE_CAP = 100;

/**
 * Polymarket API client.
 * All methods are read-only — no authentication needed.
 */
export class PolymarketClient {
  private config: ScanConfig;

  constructor(config: ScanConfig) {
    this.config = config;
  }

  // ── Internal fetch with retry ──

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const { retryCount, timeoutMs } = this.config;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retryCount; attempt++) {
      try {
        // AbortSignal.timeout covers the ENTIRE request, body read included.
        // The previous controller+clearTimeout cleared the timer as soon as the
        // headers arrived, so a slow-drip body (a rate-limited node returning
        // headers then stalling) could hang res.json() up to undici's ~300s
        // default and freeze the whole scan.
        const res = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Accept: "application/json",
            "User-Agent": "prededge-scanner/1.0",
            ...init?.headers,
          },
        });

        if (res.status === 429 || res.status >= 500) {
          if (attempt < retryCount) {
            await this.sleep(this.retryDelayMs(attempt, res));
            continue;
          }
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText} for ${url}`);
        }

        return (await res.json()) as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < retryCount) {
          await this.sleep(this.retryDelayMs(attempt));
        }
      }
    }

    throw lastError ?? new Error(`Failed to fetch ${url}`);
  }

  /**
   * Backoff for a retry. Honors the server's `Retry-After` header (seconds)
   * when present — Gamma's 429 windows are seconds long, and the old flat
   * `backoff * attempt` (<1s total) almost always re-hit the same limit.
   * Otherwise exponential (base·2^(attempt-1)) with ±25% jitter so a burst of
   * concurrent pages doesn't retry in lockstep, floored at 1s for 429s.
   */
  private retryDelayMs(attempt: number, res?: Response): number {
    const retryAfter = res?.headers.get("retry-after");
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) {
        return Math.min(secs * 1000, 30_000);
      }
    }
    const base = this.config.retryBackoffMs;
    const floor = res?.status === 429 ? 1000 : 0;
    const exp = Math.max(floor, base * 2 ** (attempt - 1));
    const jitter = exp * (0.75 + Math.random() * 0.5);
    return Math.min(Math.round(jitter), 30_000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Gamma API ──

  /**
   * Fetch one page of active markets from the Gamma API.
   */
  async fetchMarketsPage(
    limit: number,
    offset: number,
    order: string = "volume24hr",
    ascending: boolean = false
  ): Promise<GammaMarket[]> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      active: "true",
      closed: "false",
      order,
      ascending: String(ascending),
    });

    try {
      const data = await this.fetchJson<GammaMarket[] | null>(
        `${GAMMA_API}/markets?${params}`
      );
      return Array.isArray(data) ? data : [];
    } catch (err) {
      // Gamma rejects offsets past ~2000 with 422 (pagination cap added
      // mid-2026). Treat it as end-of-data so deep scans degrade to the
      // API's ceiling instead of failing outright.
      if (err instanceof Error && err.message.includes("HTTP 422")) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Fetch pages in parallel bursts for a single sort dimension.
   *
   * Gamma silently caps the page size (currently 100) no matter what `limit`
   * asks for. The old implementation requested `pageLimit` (500) rows per
   * page and treated any shorter page as "end of data", so it stopped after
   * one 100-row page and the whole scan quietly shrank to ~200 markets. We
   * page by the observed cap instead and keep going until a genuinely short
   * page signals the end.
   */
  private async fetchMarketsBySort(
    order: string,
    ascending: boolean,
    maxCount: number
  ): Promise<GammaMarket[]> {
    const pageSize = Math.min(this.config.pageLimit, GAMMA_PAGE_CAP);
    const { concurrency } = this.config;
    const all: GammaMarket[] = [];
    let offset = 0;

    while (all.length < maxCount) {
      const remainingPages = Math.ceil((maxCount - all.length) / pageSize);
      const burst = Math.max(1, Math.min(concurrency, remainingPages));
      const offsets = Array.from({ length: burst }, (_, i) => offset + i * pageSize);
      const pages = await Promise.all(
        offsets.map((o) => this.fetchMarketsPage(pageSize, o, order, ascending))
      );

      let sawShortPage = false;
      for (const page of pages) {
        all.push(...page);
        if (page.length < pageSize) {
          sawShortPage = true;
          break;
        }
      }
      if (sawShortPage) break;
      offset += burst * pageSize;
    }

    return all.slice(0, maxCount);
  }

  /**
   * Fetch markets from two dimensions in parallel, merge and deduplicate.
   * - By volume (high volume = good liquidity)
   * - By endDate ascending (soonest expiry = highest annualized yield)
   */
  async fetchAllMarkets(): Promise<GammaMarket[]> {
    const { maxMarkets } = this.config;
    const perDimension = Math.ceil(maxMarkets / 2);

    const [byVolume, byExpiry] = await Promise.all([
      this.fetchMarketsBySort("volume24hr", false, perDimension),
      this.fetchMarketsBySort("endDate", true, perDimension),
    ]);

    // Merge and deduplicate by conditionId
    const seen = new Set<string>();
    const merged: GammaMarket[] = [];

    for (const market of [...byVolume, ...byExpiry]) {
      if (!market.conditionId) continue;
      if (seen.has(market.conditionId)) continue;
      seen.add(market.conditionId);
      merged.push(market);
    }

    return merged;
  }

  /**
   * Fetch ALL open markets currently in a given UMA resolution status via
   * Gamma's `uma_resolution_status` filter. This is the coverage backstop for
   * the Official Ruling class: disputed markets are few (tens), and the two
   * sort dimensions of fetchAllMarkets can miss ones that are neither
   * high-volume nor near-expiry.
   *
   * `complete` is false when a page failed (or the offset cap cut us off) —
   * the caller surfaces that so coverage degradation is auditable instead of
   * silently shrinking the dispute-flow census.
   */
  async fetchMarketsByUmaResolutionStatus(
    status: string
  ): Promise<{ markets: GammaMarket[]; complete: boolean }> {
    const pageSize = Math.min(this.config.pageLimit, GAMMA_PAGE_CAP);
    const all: GammaMarket[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(offset),
        active: "true",
        closed: "false",
        uma_resolution_status: status,
      });
      let page: GammaMarket[];
      try {
        const data = await this.fetchJson<GammaMarket[] | null>(
          `${GAMMA_API}/markets?${params}`
        );
        page = Array.isArray(data) ? data : [];
      } catch (err) {
        // Backstop fetch must never sink the whole scan; the main list still
        // carries most disputed markets — but the shortfall must be visible.
        console.warn(
          `[client] uma_resolution_status=${status} backstop failed at offset ${offset}: ${err instanceof Error ? err.message : String(err)}`
        );
        return { markets: all, complete: false };
      }
      all.push(...page);
      if (page.length < pageSize) break;
    }
    return { markets: all, complete: true };
  }

  /**
   * Coverage backstop for the full dispute-flow class ("cohort C"):
   * - `disputed`: every open market whose CURRENT status is disputed. This
   *   also covers "reset, waiting for re-proposal" (the single-value field
   *   stays `disputed` there) and second disputes awaiting the DVM.
   * - `replay`: markets re-proposed after a dispute reset — their current
   *   status is back to `proposed` (a ~2h liveness window per round), so the
   *   disputed query can't see them. Gamma has NO server-side filter for
   *   "history contains disputed" (the plural query param does not exist —
   *   verified 2026-07-04: it is silently ignored), so we fetch the full
   *   proposed set (~600-800 rows, well under the offset-2000/422 cap) and
   *   filter client-side on the umaResolutionStatuses history field.
   */
  async fetchDisputeFlowBackstop(): Promise<{
    disputed: GammaMarket[];
    replay: GammaMarket[];
    complete: boolean;
  }> {
    const [disputedRes, proposedRes] = await Promise.all([
      this.fetchMarketsByUmaResolutionStatus("disputed"),
      this.fetchMarketsByUmaResolutionStatus("proposed"),
    ]);
    const replay = proposedRes.markets.filter((m) =>
      statusesHistoryHasDisputed(m.umaResolutionStatuses)
    );
    return {
      disputed: disputedRes.markets,
      replay,
      complete: disputedRes.complete && proposedRes.complete,
    };
  }

  // ── Event Tags ──

  /**
   * Fetch tags for a single event by slug.
   */
  async fetchEventTags(eventSlug: string): Promise<EventTag[]> {
    const cached = eventTagCache.get(eventSlug);
    if (cached) return cached;

    try {
      const data = await this.fetchJson<
        Record<string, unknown> | Record<string, unknown>[]
      >(`${GAMMA_API}/events/slug/${eventSlug}`);
      const event = Array.isArray(data) ? data[0] : data;
      const rawTags = (event as Record<string, unknown>)?.tags;
      if (!Array.isArray(rawTags)) return [];
      const tags = rawTags.map((t: Record<string, unknown>) => ({
        id: String(t.id ?? ""),
        label: String(t.label ?? ""),
        slug: String(t.slug ?? ""),
      }));
      eventTagCache.set(eventSlug, tags);
      return tags;
    } catch {
      return [];
    }
  }

  /**
   * Fetch tags for multiple events in parallel, deduplicated by event slug.
   */
  async fetchEventTagsBatch(
    eventSlugs: string[]
  ): Promise<Map<string, EventTag[]>> {
    const unique = [...new Set(eventSlugs.filter(Boolean))];
    const result = new Map<string, EventTag[]>();
    const { concurrency } = this.config;

    for (let i = 0; i < unique.length; i += concurrency) {
      const batch = unique.slice(i, i + concurrency);
      const tags = await Promise.all(
        batch.map((slug) => this.fetchEventTags(slug))
      );
      batch.forEach((slug, idx) => {
        result.set(slug, tags[idx]);
      });
    }

    return result;
  }

  // ── CLOB API ──

  /**
   * Fetch the precise BUY or SELL price for a single token.
   */
  async fetchPrice(
    tokenId: string,
    side: "BUY" | "SELL"
  ): Promise<number | null> {
    try {
      const params = new URLSearchParams({ token_id: tokenId, side });
      const data = await this.fetchJson<{ price?: string }>(
        `${CLOB_API}/price?${params}`
      );
      if (data?.price != null) {
        const parsed = parseFloat(data.price);
        return isNaN(parsed) ? null : parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch Gamma markets by a list of conditionIds.
   * Used by the trade-refresh route to check which markets have resolved.
   */
  async fetchMarketsByConditionIds(
    conditionIds: string[]
  ): Promise<Map<string, GammaMarket>> {
    const result = new Map<string, GammaMarket>();
    if (conditionIds.length === 0) return result;

    const { concurrency } = this.config;
    const unique = Array.from(new Set(conditionIds));

    // Gamma accepts multiple condition_ids via repeated params
    const chunks: string[][] = [];
    const chunkSize = 20;
    for (let i = 0; i < unique.length; i += chunkSize) {
      chunks.push(unique.slice(i, i + chunkSize));
    }

    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      const pages = await Promise.all(
        batch.map(async (chunk) => {
          // Gamma 的 condition_ids= 默认查询对已 closed 市场返回空(2026-07-11
          // tradeExecutor 实测):只发默认查询时,已结算市场永远查不到,paper
          // 单因此终身 open。每 chunk 双查询(默认 + closed=true)合并 ——
          // 与 probeAndRecordSettlement / backfill-taker-fee 的口径一致。
          const merged: GammaMarket[] = [];
          for (const closed of [false, true]) {
            const params = new URLSearchParams();
            for (const id of chunk) params.append("condition_ids", id);
            params.set("limit", String(chunk.length));
            if (closed) params.set("closed", "true");
            try {
              const data = await this.fetchJson<GammaMarket[] | null>(
                `${GAMMA_API}/markets?${params}`
              );
              if (Array.isArray(data)) merged.push(...data);
            } catch {
              // 单口径失败不影响另一口径的结果
            }
          }
          return merged;
        })
      );
      for (const page of pages) {
        for (const market of page) {
          if (market.conditionId) result.set(market.conditionId, market);
        }
      }
    }

    return result;
  }

  /**
   * Fetch Gamma markets by a list of UMA questionIDs (repeated
   * `question_ids` params). Used by the on-chain event sweep to map
   * QuestionReset / AncillaryDataUpdated events back to markets. No
   * active/closed restriction — an event may belong to a market that
   * resolved minutes ago, and that is still worth surfacing.
   */
  async fetchMarketsByQuestionIds(questionIds: string[]): Promise<GammaMarket[]> {
    const unique = Array.from(new Set(questionIds.filter(Boolean)));
    if (unique.length === 0) return [];
    const result: GammaMarket[] = [];
    const seen = new Set<string>();
    const chunkSize = 20;

    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const params = new URLSearchParams();
      for (const id of chunk) params.append("question_ids", id);
      params.set("limit", String(chunk.length));
      try {
        const data = await this.fetchJson<GammaMarket[] | null>(
          `${GAMMA_API}/markets?${params}`
        );
        for (const market of Array.isArray(data) ? data : []) {
          if (!market.conditionId || seen.has(market.conditionId)) continue;
          seen.add(market.conditionId);
          result.push(market);
        }
      } catch {
        // best-effort mapping; unmatched ids stay visible upstream
      }
    }
    return result;
  }

  /**
   * Fetch the order book for a single token.
   *
   * CLOB `/book` returns a ms-precision `timestamp` field (sometimes empty
   * for illiquid markets). When it's present and the snapshot is older than
   * `maxAgeMs`, we treat the result as stale and return null — the scanner
   * will skip the candidate rather than emit a stale opportunity. Empty /
   * unparseable timestamps are tolerated (Polymarket returns them for
   * freshly-created or low-volume markets). Disputed markets trade rarely, so
   * their snapshots are routinely older than the 60s default — callers pass a
   * larger `maxAgeMs` for those instead of silently dropping them.
   */
  async fetchBook(tokenId: string, maxAgeMs = 60_000): Promise<OrderBook | null> {
    return (await this.fetchBookResult(tokenId, maxAgeMs)).book;
  }

  /**
   * Like fetchBook but distinguishes a genuine fetch FAILURE (timeout, 429
   * exhausted, connection blocked) from a book that merely came back empty or
   * stale. The scanner needs this distinction: a stale/empty book is a real
   * "no opportunity here" signal, but a fetch failure means the candidate was
   * never actually evaluated — silently dropping those makes a notification gap
   * look identical to a clean scan. `failed` is true only for the former.
   */
  async fetchBookResult(
    tokenId: string,
    maxAgeMs = 60_000
  ): Promise<{ book: OrderBook | null; failed: boolean }> {
    let data: OrderBook | null;
    try {
      const params = new URLSearchParams({ token_id: tokenId });
      data = await this.fetchJson<OrderBook>(`${CLOB_API}/book?${params}`);
    } catch (err) {
      // Deterministic 4xx (except 429) is a real answer, not a failure: a
      // just-resolved/delisted market's /book returns 404 "no orderbook
      // exists". Counting that as `failed` would trip booksIncomplete and fire a
      // false coverage-degradation alert on every scan that races a market
      // resolution. Only timeouts / connection errors / exhausted 429/5xx
      // retries count as failed.
      const status = err instanceof Error ? /^HTTP (\d{3}):/.exec(err.message)?.[1] : null;
      if (status && status !== "429" && status.startsWith("4")) {
        return { book: null, failed: false };
      }
      return { book: null, failed: true };
    }
    if (!data) return { book: null, failed: false };
    const tsRaw = data.timestamp;
    if (tsRaw && /^\d+$/.test(tsRaw)) {
      const ts = Number(tsRaw);
      if (Number.isFinite(ts) && ts > 0) {
        const age = Date.now() - ts;
        if (age > maxAgeMs) return { book: null, failed: false }; // stale, not failed
      }
    }
    return { book: data, failed: false };
  }

  /**
   * Fetch prices for multiple tokens concurrently, respecting concurrency limit.
   */
  async fetchPricesBatch(
    tokenIds: string[],
    side: "BUY" | "SELL"
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const { concurrency } = this.config;

    for (let i = 0; i < tokenIds.length; i += concurrency) {
      const batch = tokenIds.slice(i, i + concurrency);
      const prices = await Promise.all(
        batch.map((id) => this.fetchPrice(id, side))
      );
      batch.forEach((id, idx) => {
        if (prices[idx] != null) {
          result.set(id, prices[idx]);
        }
      });
    }

    return result;
  }

  /**
   * Fetch order books for multiple tokens concurrently.
   */
  async fetchBooksBatch(
    tokenIds: string[],
    maxAgeMs?: number
  ): Promise<{ books: Map<string, OrderBook>; failedTokenIds: Set<string> }> {
    const books = new Map<string, OrderBook>();
    const failedTokenIds = new Set<string>();
    const { concurrency } = this.config;

    for (let i = 0; i < tokenIds.length; i += concurrency) {
      const batch = tokenIds.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map((id) => this.fetchBookResult(id, maxAgeMs))
      );
      batch.forEach((id, idx) => {
        if (results[idx].book) {
          books.set(id, results[idx].book!);
        } else if (results[idx].failed) {
          failedTokenIds.add(id);
        }
      });
    }

    return { books, failedTokenIds };
  }
}
