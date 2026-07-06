import type { ScanConfig } from "../types";

export const GAMMA_API = "https://gamma-api.polymarket.com";
export const CLOB_API = "https://clob.polymarket.com";

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  tailPriceMin: 0.93,
  tailPriceMax: 0.995,
  minDepthUsd: 200,
  minNetReturnPct: 0.004,
  maxMarkets: 10000,
  pageLimit: 500,
  feePct: 0.002,
  transferCostPct: 0.0005,
  nearPriceBand: 0.003,
  dustLevelUsd: 25,
  concurrency: 15,
  timeoutMs: 15000,
  retryCount: 2,
  retryBackoffMs: 300,
};
