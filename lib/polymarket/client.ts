import type { GammaMarket, OrderBook, EventTag, ScanConfig } from "../types";
import { GAMMA_API, CLOB_API } from "./config";

const eventTagCache = new Map<string, EventTag[]>();

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
    const { retryCount, retryBackoffMs, timeoutMs } = this.config;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retryCount; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(url, {
          ...init,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "User-Agent": "prededge-scanner/1.0",
            ...init?.headers,
          },
        });
        clearTimeout(timer);

        if (res.status === 429 || res.status >= 500) {
          if (attempt < retryCount) {
            await this.sleep(retryBackoffMs * attempt);
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
          await this.sleep(retryBackoffMs * attempt);
        }
      }
    }

    throw lastError ?? new Error(`Failed to fetch ${url}`);
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

    const data = await this.fetchJson<GammaMarket[] | null>(
      `${GAMMA_API}/markets?${params}`
    );
    return Array.isArray(data) ? data : [];
  }

  /**
   * Fetch pages in parallel for a single sort dimension.
   */
  private async fetchMarketsBySort(
    order: string,
    ascending: boolean,
    maxCount: number
  ): Promise<GammaMarket[]> {
    const { pageLimit } = this.config;
    const pageCount = Math.ceil(maxCount / pageLimit);
    const offsets = Array.from({ length: pageCount }, (_, i) => i * pageLimit);

    const pages = await Promise.all(
      offsets.map((offset) =>
        this.fetchMarketsPage(pageLimit, offset, order, ascending)
      )
    );

    const all: GammaMarket[] = [];
    for (const page of pages) {
      all.push(...page);
      if (page.length < pageLimit) break;
    }
    return all;
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
          const params = new URLSearchParams();
          for (const id of chunk) params.append("condition_ids", id);
          params.set("limit", String(chunk.length));
          // Don't restrict by active/closed — we want to see BOTH resolved and open
          try {
            const data = await this.fetchJson<GammaMarket[] | null>(
              `${GAMMA_API}/markets?${params}`
            );
            return Array.isArray(data) ? data : [];
          } catch {
            return [];
          }
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
   * Fetch the order book for a single token.
   *
   * CLOB `/book` returns a ms-precision `timestamp` field (sometimes empty
   * for illiquid markets). When it's present and the snapshot is older than
   * MAX_BOOK_AGE_MS, we treat the result as stale and return null — the
   * scanner will skip the candidate rather than emit a stale opportunity.
   * Empty / unparseable timestamps are tolerated (Polymarket returns them
   * for freshly-created or low-volume markets).
   */
  async fetchBook(tokenId: string): Promise<OrderBook | null> {
    const MAX_BOOK_AGE_MS = 60_000;
    try {
      const params = new URLSearchParams({ token_id: tokenId });
      const data = await this.fetchJson<OrderBook>(
        `${CLOB_API}/book?${params}`
      );
      if (!data) return null;
      const tsRaw = data.timestamp;
      if (tsRaw && /^\d+$/.test(tsRaw)) {
        const ts = Number(tsRaw);
        if (Number.isFinite(ts) && ts > 0) {
          const age = Date.now() - ts;
          if (age > MAX_BOOK_AGE_MS) return null;
        }
      }
      return data;
    } catch {
      return null;
    }
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
    tokenIds: string[]
  ): Promise<Map<string, OrderBook>> {
    const result = new Map<string, OrderBook>();
    const { concurrency } = this.config;

    for (let i = 0; i < tokenIds.length; i += concurrency) {
      const batch = tokenIds.slice(i, i + concurrency);
      const books = await Promise.all(
        batch.map((id) => this.fetchBook(id))
      );
      batch.forEach((id, idx) => {
        if (books[idx]) {
          result.set(id, books[idx]);
        }
      });
    }

    return result;
  }
}
