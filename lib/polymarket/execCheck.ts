/**
 * Executability check for chain-watch alerts (改进 I1).
 *
 * The 15-month backtest's核心事实: 87% of directional notifications had no
 * $100 of real fills within 2h of the signal — the inbox flood was mostly
 * un-tradeable. This module answers, at notify time, "if I opened the app
 * right now, could I actually buy the official direction, at what price,
 * with how much size?" — by mapping the on-chain qid to its Gamma market
 * (conditionId = keccak256(adapter‖qid‖2)) and reading the CLOB book for the
 * directional token.
 *
 * Fail-open by design: chain-watch's job is the timely alert; Gamma/CLOB sit
 * behind the box's proxy and may be down when the chain is fine. Every
 * failure returns null and the alert goes out un-annotated. Neg-risk events
 * (qid = negRiskRequestID, whose conditionId derives from the NegRiskAdapter
 * instead) miss the condition_ids lookup and fall through to question_ids;
 * if both miss we return null rather than guessing.
 *
 * Env: EXEC_CHECK=off disables (annotation absent, alerts unaffected).
 */
import { GAMMA_API, CLOB_API } from "./config";
import { conditionIdFor } from "./keccak";
import type { GammaMarket, OrderBook } from "../types";

export const MIN_EXEC_USD = 100;
/** Count ask depth only this far above best ask — deeper levels are not "the
 * price you'd pay", they're the slippage cliff. */
const NEAR_ASK_BAND = 0.05;
const FETCH_TIMEOUT_MS = 6_000;

export interface ExecFill {
  price: number;
  size: number;
  cost: number;
}

export interface ExecCheck {
  conditionId: string;
  gammaId: string;
  question: string;
  slug: string | null;
  marketUrl: string | null;
  outcomes: string[];
  /** The outcome side the official direction implies buying. */
  outcome: string;
  tokenId: string;
  dirMethod: "yes-side" | "no-side" | "outcome-exact" | "bucket-contains" | "bucket-anti";
  bestAsk: number | null;
  bestBid: number | null;
  /** Ask-side notional (USD) within NEAR_ASK_BAND of best ask. */
  askUsdNear: number;
  /** askUsdNear ≥ MIN_EXEC_USD — the backtest's "真可执行" bar. */
  executable: boolean;
  /** Simulated $100 market buy walking the asks (null when book too thin). */
  fill100: { avgPrice: number; worstPrice: number; shares: number; usd: number; fills: ExecFill[] } | null;
  endDate: string | null;
  closed: boolean;
  negRisk: boolean;
  feesEnabled: boolean | null;
  feeRate: number | null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value == null) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** 方向 stance 的整串匹配(仅容 leans_ 前缀)。P0-2:原 /YES$/i、/NO$/i 是
 * 子串后缀匹配,resolve_to_bruno、resolve_to_hayes 之类以 -no/-yes 结尾的
 * 标签会被劫持到 yes/no 分支,永远到不了 outcome-exact。 */
const YES_STANCE = /^(?:leans_)?yes$/i;
const NO_STANCE = /^(?:leans_)?no$/i;

/** 极性归一(标题分诊与复判一致性共用):YES/leans_YES → "+",NO/leans_NO
 * → "-",其余(含 resolve_to_*)原样返回、要求字面一致 —— 刻意不做
 * resolve_to 归一化比较:放宽它会扩大 🟢 覆盖面,必须等方向映射正确性在
 * 生产验证后再单独评估(P0-2 顺序警告)。 */
export function stancePolarity(stance: string): string {
  if (YES_STANCE.test(stance)) return "+";
  if (NO_STANCE.test(stance)) return "-";
  return stance;
}

/** Map a directional stance to the outcome side it implies buying. Same
 * decision table the backtest's economics used (dirMethod hard-error rate
 * concentrated in bucket heuristics — those stay lowest-trust downstream:
 * 自动执行白名单只放行 yes-side/no-side/outcome-exact,见 chain-watch)。 */
export function directionalOutcomeIndex(
  stance: string,
  outcomes: string[],
  question: string | null
): { index: number; method: ExecCheck["dirMethod"] } | null {
  const lower = outcomes.map((o) => o.toLowerCase().trim());
  // resolve_to_ 前缀必须最先判:它的标签是自由词,先走后缀正则就会被劫持(P0-2)。
  if (stance.startsWith("resolve_to_")) {
    const label = stance.slice("resolve_to_".length).toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
    const exact = lower.indexOf(label);
    if (exact >= 0) return { index: exact, method: "outcome-exact" };
    const isYesNo = outcomes.length === 2 && [...lower].sort().join() === "no,yes";
    if (isYesNo) {
      const q = (question ?? "").toLowerCase();
      if (q.includes(label)) return { index: lower.indexOf("yes"), method: "bucket-contains" };
      return { index: lower.indexOf("no"), method: "bucket-anti" };
    }
    return null;
  }
  // YES/NO 只在市场确实存在同名 outcome 时映射;找不到就返回 null——
  // fallback 到固定下标 0/1 等于在非 yes/no 市场随机买一边,确定性 -100%。
  if (YES_STANCE.test(stance)) {
    const i = lower.indexOf("yes");
    return i >= 0 ? { index: i, method: "yes-side" } : null;
  }
  if (NO_STANCE.test(stance)) {
    const i = lower.indexOf("no");
    return i >= 0 ? { index: i, method: "no-side" } : null;
  }
  return null;
}

async function lookupMarket(adapter: string, qid: string): Promise<GammaMarket | null> {
  const cid = conditionIdFor(adapter, qid);
  try {
    const byCid = await fetchJson<GammaMarket[] | null>(
      `${GAMMA_API}/markets?condition_ids=${cid}&limit=2`
    );
    const hit = (Array.isArray(byCid) ? byCid : []).find(
      (m) => m.conditionId?.toLowerCase() === cid.toLowerCase()
    );
    if (hit) return hit;
  } catch {
    // fall through to question_ids
  }
  try {
    const byQid = await fetchJson<GammaMarket[] | null>(
      `${GAMMA_API}/markets?question_ids=${qid}&limit=2`
    );
    const hit = (Array.isArray(byQid) ? byQid : []).find(
      (m) => m.questionID?.toLowerCase() === qid.toLowerCase()
    );
    if (hit) return hit;
  } catch {
    // both routes failed
  }
  return null;
}

/**
 * Look up the market for an on-chain (adapter, qid) and measure how much of
 * the official direction is actually buyable right now. Returns null on any
 * failure or when the direction cannot be mapped to an outcome side.
 */
export async function checkExecutability(input: {
  adapter: string;
  qid: string;
  /** Effective directional stance (regex stance when directional, else the
   * LLM stance) — decides which outcome side to price. */
  stance: string;
}): Promise<ExecCheck | null> {
  if ((process.env.EXEC_CHECK ?? "").trim().toLowerCase() === "off") return null;
  try {
    const market = await lookupMarket(input.adapter, input.qid);
    if (!market) return null;

    const outcomes = parseJsonArray(market.outcomes);
    const tokenIds = parseJsonArray(market.clobTokenIds);
    if (outcomes.length === 0 || tokenIds.length !== outcomes.length) return null;

    const dir = directionalOutcomeIndex(input.stance, outcomes, market.question);
    if (!dir || dir.index < 0 || dir.index >= tokenIds.length) return null;
    const tokenId = tokenIds[dir.index];

    let bestAsk: number | null = null;
    let bestBid: number | null = null;
    let askUsdNear = 0;
    let fill100: ExecCheck["fill100"] = null;

    if (!market.closed && market.enableOrderBook !== false) {
      const book = await fetchJson<OrderBook>(`${CLOB_API}/book?token_id=${tokenId}`);
      const asks = (book.asks ?? [])
        .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
        .sort((a, b) => a.price - b.price);
      const bids = (book.bids ?? [])
        .map((l) => Number(l.price))
        .filter((p) => Number.isFinite(p))
        .sort((a, b) => b - a);
      bestBid = bids[0] ?? null;
      if (asks.length > 0) {
        bestAsk = asks[0].price;
        const ceiling = Math.min(bestAsk + NEAR_ASK_BAND, 0.999);
        for (const l of asks) {
          if (l.price > ceiling) break;
          askUsdNear += l.price * l.size;
        }
        // Walk the asks for a simulated $100 market buy.
        let usdLeft = MIN_EXEC_USD;
        let shares = 0;
        let cost = 0;
        const fills: ExecFill[] = [];
        for (const l of asks) {
          if (usdLeft <= 0.01) break;
          const take = Math.min(l.size, usdLeft / l.price);
          fills.push({ price: l.price, size: take, cost: take * l.price });
          shares += take;
          cost += take * l.price;
          usdLeft -= take * l.price;
        }
        if (cost >= MIN_EXEC_USD - 0.01 && shares > 0) {
          fill100 = {
            avgPrice: cost / shares,
            worstPrice: fills[fills.length - 1].price,
            shares,
            usd: cost,
            fills,
          };
        }
      }
    }

    const rate = market.feeSchedule?.rate;
    return {
      conditionId: market.conditionId,
      gammaId: market.id,
      question: market.question,
      slug: market.slug || null,
      marketUrl: market.slug ? `https://polymarket.com/market/${market.slug}` : null,
      outcomes,
      outcome: outcomes[dir.index],
      tokenId,
      dirMethod: dir.method,
      bestAsk,
      bestBid,
      askUsdNear: Math.round(askUsdNear * 100) / 100,
      executable: askUsdNear >= MIN_EXEC_USD,
      fill100,
      endDate: market.endDate ?? null,
      closed: market.closed === true,
      negRisk: market.negRisk === true,
      feesEnabled: market.feesEnabled ?? null,
      feeRate: typeof rate === "number" ? rate : null,
    };
  } catch {
    return null; // fail-open: annotation is enrichment, never a gate on the alert itself
  }
}
