import type { GammaMarket, OfficialContext, Opportunity } from "../types";
import { adapterQuestionID, ethCall, isHex } from "./oracleState";
import { isDirectionalStance } from "../virtualTags";

export { isDirectionalStance };

/**
 * Official additional-context reader and stance classifier.
 *
 * Polymarket's official clarifications/rulings ("additional context") are NOT
 * exposed by the Gamma API — they live on-chain in the UMA CTF adapter and are
 * readable via `getQuestion(questionID)` (to recover the question creator) and
 * `getUpdates(questionID, owner)` (both arguments required; the single-arg
 * form returns nothing). The stance rules and the price fallback were
 * validated by the dispute-arb research (tmp/dispute-analysis/): markets where
 * officials wrote a directional context settled the official way 32/32.
 */

const SELECTORS = {
  getQuestion: "0x58c039cd",
  getUpdates: "0x555c56fc",
};

/** A disputed market priced at an extreme implies the leading side even when
 * the official text is absent or carries no parseable direction. */
const PRICE_FALLBACK_MIN = 0.9;

const EXCERPT_MAX_CHARS = 500;

export interface OfficialUpdate {
  timestamp: number;
  iso: string;
  text: string;
}

// ── ABI decode helpers (self-contained; oracleState keeps its own copies) ──

function wordAt(hex: string, byteOffset: number): string {
  return hex.slice(2 + byteOffset * 2, 2 + byteOffset * 2 + 64);
}

function uintWord(word: string): bigint {
  return BigInt(`0x${word || "0"}`);
}

function addressFromWord(word: string): string {
  return `0x${word.slice(-40)}`.toLowerCase();
}

function addressArg(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function bytesToUtf8(hexWithout0x: string): string {
  return Buffer.from(hexWithout0x, "hex").toString("utf8");
}

function decodeBytes(hex: string, byteOffset: number): { length: number; text: string } {
  const length = Number(uintWord(wordAt(hex, byteOffset)));
  const start = byteOffset + 32;
  const body = hex.slice(2 + start * 2, 2 + (start + length) * 2);
  return { length, text: bytesToUtf8(body) };
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * Scan-based getQuestion decoder that also recovers the question creator.
 * Adapter versions differ in struct layout, so instead of assuming a fixed
 * word offset (like oracleState's decodeQuestion) this walks the candidate
 * offsets until it finds the dynamic bytes field whose payload looks like
 * ancillary data; the creator address sits in the word right before it.
 */
function decodeQuestionWithCreator(
  result: string
): { requestTimestamp: number; creator: string } | null {
  if (!result || result === "0x") return null;
  const byteLength = (result.length - 2) / 2;
  const base = Number(uintWord(wordAt(result, 0)));
  if (!Number.isFinite(base) || base < 0 || base + 32 > byteLength) {
    throw new Error("invalid getQuestion base offset");
  }
  const requestTimestamp = Number(uintWord(wordAt(result, base)));

  let offsetIndex: number | null = null;
  for (let i = 4; i < 32; i += 1) {
    const candidate = Number(uintWord(wordAt(result, base + i * 32)));
    if (candidate < 32 || candidate % 32 !== 0) continue;
    const lengthWordOffset = base + candidate;
    if (lengthWordOffset + 32 > byteLength) continue;
    const length = Number(uintWord(wordAt(result, lengthWordOffset)));
    if (length <= 0 || length > 20_000) continue;
    const bodyStart = 2 + (lengthWordOffset + 32) * 2;
    const bodyEnd = bodyStart + length * 2;
    if (bodyEnd > result.length) continue;
    const text = bytesToUtf8(result.slice(bodyStart, bodyEnd));
    if (/q:\s*title|title:|description:|resolution/i.test(text)) {
      offsetIndex = i;
      break;
    }
  }
  if (offsetIndex == null || offsetIndex < 1) {
    throw new Error("could not locate ancillaryData in getQuestion result");
  }

  const creator = addressFromWord(wordAt(result, base + (offsetIndex - 1) * 32));
  return { requestTimestamp, creator };
}

function decodeUpdates(raw: string): OfficialUpdate[] {
  if (!raw || raw === "0x") return [];
  const base = Number(uintWord(wordAt(raw, 0)));
  const length = Number(uintWord(wordAt(raw, base)));
  const updates: OfficialUpdate[] = [];

  for (let i = 0; i < length; i += 1) {
    const tupleOffset = Number(uintWord(wordAt(raw, base + 32 + i * 32)));
    const tupleBase = base + 32 + tupleOffset;
    const timestamp = Number(uintWord(wordAt(raw, tupleBase)));
    const textOffset = Number(uintWord(wordAt(raw, tupleBase + 32)));
    const textBytes = decodeBytes(raw, tupleBase + textOffset);
    updates.push({ timestamp, iso: iso(timestamp), text: textBytes.text });
  }
  return updates;
}

/**
 * Read all official context updates for a market from the UMA CTF adapter.
 * Throws on RPC/decode failure — callers handle retry/fallback.
 */
export async function getOfficialUpdates(input: {
  resolvedBy: string;
  questionID: string;
}): Promise<{ updates: OfficialUpdate[]; creator: string | null }> {
  const questionResult = await ethCall(
    input.resolvedBy,
    `${SELECTORS.getQuestion}${input.questionID.slice(2)}`
  );
  const question = decodeQuestionWithCreator(questionResult);
  if (!question?.creator) return { updates: [], creator: null };

  const updateData = [
    SELECTORS.getUpdates,
    input.questionID.slice(2),
    addressArg(question.creator),
  ].join("");
  const rawUpdates = await ethCall(input.resolvedBy, updateData);
  return {
    updates: decodeUpdates(rawUpdates).sort((a, b) => a.timestamp - b.timestamp),
    creator: question.creator,
  };
}

// ── Stance classification ──

export function stanceFromText(text: string | null | undefined): {
  stance: string;
  confidence: "high" | "medium" | "low" | "none";
} {
  const lower = String(text ?? "").toLowerCase();
  if (!lower) return { stance: "none", confidence: "none" };
  if (/remain open|not enough information|open investigation|clear resolution is reached/.test(lower)) {
    return { stance: "stay_open", confidence: "medium" };
  }
  const explicitOutcome = lower.match(
    /(?:should\s+resolve\s+to|will\s+immediately\s+resolve\s+to)\s+["“]?([a-z0-9 ._+-]+)["”]?/
  );
  if (explicitOutcome?.[1]) {
    const outcome = explicitOutcome[1].trim().replace(/\s+/g, "_");
    if (outcome === "yes") return { stance: "YES", confidence: "high" };
    if (outcome === "no") return { stance: "NO", confidence: "high" };
    return { stance: `resolve_to_${outcome}`, confidence: "high" };
  }
  if (/per the rules/.test(lower) && /will resolve to/.test(lower) && /\bif\b/.test(lower)) {
    return { stance: "rule_context", confidence: "low" };
  }
  if (
    /qualifies|qualify toward|officially listed|officially announced|qualifying/.test(lower) &&
    !/does not qualify|do not qualify|do not alone constitute|not qualify|will not qualify|not count|does not count/.test(lower)
  ) {
    return { stance: "leans_YES", confidence: "medium" };
  }
  if (
    /does not qualify|do not qualify|do not alone constitute|not qualify|will not qualify|not count|does not count|data which is clearly erroneous will not qualify|not alone meet/.test(lower)
  ) {
    return { stance: "leans_NO", confidence: "medium" };
  }
  if (/updated for clarity|language has been updated|rules have been updated/.test(lower)) {
    return { stance: "clarity_only", confidence: "low" };
  }
  if (/aware of the dispute/.test(lower)) {
    return { stance: "dispute_notice", confidence: "medium" };
  }
  return { stance: "rule_context", confidence: "low" };
}

/** True when any update text promises refunds (or a 50/50 split) — the
 * "losing" side then carries no real risk and the spread is not edge.
 * Negated mentions ("no refunds will be issued", "will not be refunded",
 * "non-refundable") are officials saying settlement proceeds normally —
 * the exact opposite — so they must NOT trip this flag. */
export function detectRefundClause(texts: Array<string | null | undefined>): boolean {
  return texts.some((t) => {
    const lower = String(t ?? "").toLowerCase();
    if (/\b50\s*\/\s*50\b/.test(lower)) return true;
    if (!/refund/.test(lower)) return false;
    const negated =
      /\b(?:no|not|never|won'?t|without)\b[^.;]{0,40}?refund|non-?refundable|refunds?\s+will\s+not\b/;
    // Strip negated mentions; a refund clause stands only if a bare
    // affirmative mention survives.
    const stripped = lower.replace(new RegExp(negated.source, "g"), "");
    return /refund/.test(stripped);
  });
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

export function marketIsDisputed(
  market: Pick<GammaMarket, "umaResolutionStatus" | "umaResolutionStatuses"> | null | undefined
): boolean {
  if (!market) return false;
  // Same trim/lowercase normalization as the scanner — a Gamma casing drift
  // must not silently disable the price fallback.
  if (market.umaResolutionStatus?.trim().toLowerCase() === "disputed") return true;
  return parseJsonArray(market.umaResolutionStatuses).some(
    (s) => s.trim().toLowerCase() === "disputed"
  );
}

function topOutcome(
  market: Pick<GammaMarket, "outcomes" | "outcomePrices"> | null | undefined
): { price: number; label: string } | null {
  const prices = parseJsonArray(market?.outcomePrices).map(Number);
  const outcomes = parseJsonArray(market?.outcomes);
  if (!prices.length) return null;
  let idx = 0;
  for (let i = 1; i < prices.length; i += 1) {
    if (prices[i] > prices[idx]) idx = i;
  }
  const price = prices[idx];
  const label = outcomes[idx];
  if (!Number.isFinite(price) || label == null) return null;
  return { price, label };
}

/**
 * Price/dispute fallback: when the official text gives no direction (or hasn't
 * been written yet) but the market is already disputed and priced at an
 * extreme, treat the leading side as the implied resolution. The confidence
 * flag lets downstream consumers weight these lower than an explicit call.
 */
export function fallbackStanceFromMarket(
  market:
    | Pick<GammaMarket, "umaResolutionStatus" | "umaResolutionStatuses" | "outcomes" | "outcomePrices">
    | null
    | undefined
): { stance: string; confidence: "price_fallback"; price: number } | null {
  if (!market || !marketIsDisputed(market)) return null;
  const top = topOutcome(market);
  if (!top || top.price < PRICE_FALLBACK_MIN) return null;
  const norm = String(top.label).toLowerCase();
  const stance =
    norm === "yes" ? "YES" : norm === "no" ? "NO" : `resolve_to_${norm.replace(/\s+/g, "_")}`;
  return { stance, confidence: "price_fallback", price: top.price };
}

// ── Alignment ──

function normalizeOutcomeName(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, "_");
}

/**
 * Relate an official stance to one side of a market. `outcomeTokens` (all
 * outcome names of the market) lets resolve_to_<x> distinguish "the sibling
 * side loses" from "this ruling talks about a label this market doesn't have"
 * — the latter must stay `unknown` so an event-level ruling is never projected
 * onto the wrong bucket.
 */
export function stanceAlignment(
  stance: string,
  outcome: string,
  outcomeTokens?: Record<string, string> | null
): "aligned" | "contradicts" | "unknown" {
  const side = normalizeOutcomeName(outcome);
  if (stance === "YES" || stance === "leans_YES") {
    if (side === "yes") return "aligned";
    if (side === "no") return "contradicts";
    return "unknown";
  }
  if (stance === "NO" || stance === "leans_NO") {
    if (side === "no") return "aligned";
    if (side === "yes") return "contradicts";
    return "unknown";
  }
  if (stance.startsWith("resolve_to_")) {
    const target = stance.slice("resolve_to_".length);
    if (target === side) return "aligned";
    const knownOutcomes = Object.keys(outcomeTokens ?? {}).map(normalizeOutcomeName);
    if (knownOutcomes.includes(target)) return "contradicts";
    return "unknown";
  }
  return "unknown";
}

// ── Assembly ──

/**
 * Combine on-chain updates and the Gamma market snapshot into an
 * OfficialContext. Text wins; when the text carries no direction (or there is
 * no text) and the market is disputed at an extreme price, the price fallback
 * supplies the direction. Returns null when there is nothing to show at all.
 */
export function buildOfficialContext(
  updates: OfficialUpdate[],
  market: GammaMarket | null
): OfficialContext | null {
  const latest = updates.length > 0 ? updates[updates.length - 1] : null;

  // Newest directional text wins (two-stage pattern: boundary note first,
  // ruling appended after the dispute).
  let textStance: { stance: string; confidence: "high" | "medium" | "low" | "none" } | null = null;
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const classified = stanceFromText(updates[i].text);
    if (isDirectionalStance(classified.stance)) {
      textStance = classified;
      break;
    }
  }
  if (!textStance && latest) textStance = stanceFromText(latest.text);

  const refundClause = detectRefundClause(updates.map((u) => u.text));

  if (textStance && isDirectionalStance(textStance.stance)) {
    return {
      stance: textStance.stance,
      confidence: textStance.confidence,
      via: "text",
      updateCount: updates.length,
      lastUpdateAt: latest?.iso ?? null,
      excerpt: latest ? latest.text.slice(0, EXCERPT_MAX_CHARS) : null,
      refundClause,
    };
  }

  const fallback = fallbackStanceFromMarket(market);
  if (fallback) {
    return {
      stance: fallback.stance,
      confidence: "price_fallback",
      via: "price_fallback",
      updateCount: updates.length,
      lastUpdateAt: latest?.iso ?? null,
      excerpt: latest ? latest.text.slice(0, EXCERPT_MAX_CHARS) : null,
      refundClause,
    };
  }

  if (!latest) return null;
  return {
    stance: textStance?.stance ?? "none",
    confidence: textStance?.confidence ?? "none",
    via: "text",
    updateCount: updates.length,
    lastUpdateAt: latest.iso,
    excerpt: latest.text.slice(0, EXCERPT_MAX_CHARS),
    refundClause,
  };
}

/**
 * Fetch + classify official context for disputed opportunities, in place.
 * One RPC round per unique (adapter, questionID) — both sides of a market and
 * duplicate buckets share the cached result. Never throws: RPC failures fall
 * back to the price-implied stance (pure local data), then to null.
 */
export async function attachOfficialContexts(
  opportunities: Opportunity[],
  marketsByConditionId: Map<string, GammaMarket>,
  concurrency = 4
): Promise<void> {
  const unique = new Map<string, { resolvedBy: string; questionID: string }>();
  for (const opp of opportunities) {
    const qid = adapterQuestionID(opp);
    if (!isHex(opp.resolvedBy, 20) || !qid) continue;
    unique.set(`${opp.resolvedBy.toLowerCase()}:${qid.toLowerCase()}`, {
      resolvedBy: opp.resolvedBy,
      questionID: qid,
    });
  }

  const updatesByKey = new Map<string, OfficialUpdate[]>();
  const entries = [...unique.entries()];
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async ([key, input]) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const { updates } = await getOfficialUpdates(input);
            updatesByKey.set(key, updates);
            return;
          } catch (err) {
            if (attempt === 0) continue;
            console.warn(
              `[officialContext] getUpdates failed for ${input.questionID}: ${err instanceof Error ? err.message : String(err)}`
            );
            updatesByKey.set(key, []);
          }
        }
      })
    );
  }

  for (const opp of opportunities) {
    const qid = adapterQuestionID(opp);
    const key =
      isHex(opp.resolvedBy, 20) && qid
        ? `${opp.resolvedBy.toLowerCase()}:${qid.toLowerCase()}`
        : null;
    const updates = (key ? updatesByKey.get(key) : null) ?? [];
    const market = marketsByConditionId.get(opp.conditionId) ?? null;
    opp.officialContext = buildOfficialContext(updates, market);
  }
}

/**
 * Decision integration for an opportunity carrying an officialContext:
 * - stance aligned with this side  → informational "official_direction_backed"
 * - stance contradicts this side   → never actionable ("official_contradicts_side")
 * - refund clause present          → never actionable ("refund_clause")
 */
export function applyOfficialContextDecision(opp: Opportunity): void {
  const ctx = opp.officialContext;
  if (!ctx) return;
  const reasons = opp.decisionReasons ?? (opp.decisionReasons = []);
  const demote = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
    if (opp.decision === "actionable") opp.decision = "observe";
  };

  if (ctx.refundClause) demote("refund_clause");

  if (isDirectionalStance(ctx.stance)) {
    const alignment = stanceAlignment(ctx.stance, opp.outcome, opp.outcomeTokens);
    if (alignment === "aligned") {
      if (!reasons.includes("official_direction_backed")) {
        reasons.push("official_direction_backed");
      }
    } else if (alignment === "contradicts") {
      demote("official_contradicts_side");
    }
  }
}
