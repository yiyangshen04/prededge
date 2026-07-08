/**
 * Chain-only dispute watcher — the degraded-network mode for remote boxes
 * that can reach Polygon RPCs but NOT gamma-api/clob (SNI-blocked, e.g. the
 * sufe deployment without a proxy).
 *
 * Every cron tick (default 3 min) it sweeps QuestionReset +
 * AncillaryDataUpdated events since the last tick, reads the question title
 * and official context straight from the chain, classifies the official
 * stance, and emails ONLY directional events (2026-07-08 narrowing — 97.3% of
 * raw dispute events carry no official direction and are not actionable):
 *   - regex-directional official context (the 32/32 signal class), or
 *   - regex-directionless text that a headless-Claude second read judges
 *     directional (catches definitional rulings; via=llm, quoted evidence).
 * Non-directional events still hit the log line and the notified-state
 * fingerprints; they come back through the gate when officials add text.
 *
 * Prices/depth (改进 I1, 2026-07-08): mailable items get a best-effort
 * executability annotation — qid→conditionId→Gamma→CLOB book via the box's
 * proxy — because the 15-month backtest showed 87% of directional alerts had
 * no $100 of real liquidity. The annotation is enrichment only: every
 * Gamma/CLOB failure degrades to the plain alert (title, official excerpt,
 * classified direction, search link). State (block cursor + notified set +
 * digest queue) lives in a JSON file; sqlite is used only opportunistically
 * for paper-trade registration (I6) and skipped where unavailable.
 *
 * Run: npx tsx scripts/chain-watch.ts
 * Env: ONCHAIN_RPC_URLS (comma-sep; default publicnode+1rpc), MAIL_* (mailer.ts),
 *      CHAIN_WATCH_STATE (default data/chain-watch-state.json)
 */
import { readFileSync } from "fs";
import path from "path";
import { sendMail } from "./mailer";
import { ethCall } from "../lib/polymarket/oracleState";
import { getOfficialUpdates, stanceFromText, detectRefundClause } from "../lib/polymarket/officialContext";
import type { OfficialUpdate } from "../lib/polymarket/officialContext";
import { classifyStanceWithLlm, llmCliCallCount, type LlmStanceVerdict } from "../lib/polymarket/llmStance";
import { checkExecutability, type ExecCheck } from "../lib/polymarket/execCheck";
import { isDirectionalStance } from "../lib/virtualTags";
import { KNOWN_ADAPTERS } from "../lib/polymarket/onchainEvents";
import { writeFileAtomic } from "../lib/fsAtomic";

/** Full HTML entity escape for any chain-sourced string spliced into email
 * body HTML. Market titles/context text come from permissionless on-chain
 * ancillary data (any third party controls them), so they must be escaped or
 * a creator can inject arbitrary HTML / phishing links into the alert. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TOPIC_QUESTION_RESET =
  "0x7981b5832932948db4e32a4a16a0f44b2ce7ff088574afb9364b313f70f82e8f";
const TOPIC_ANCILLARY_UPDATED =
  "0x0059e11815211969c0c4aaf3f498b52b6c2f2d14f286275d0862d70de22a836b";
const GET_QUESTION_SELECTOR = "0x58c039cd";

// Max lookback after downtime: ~3600 blocks ≈ 2 hours. publicnode only serves
// getLogs hugging the chain head (~127 blocks), so deeper pages fall through to
// the fallback RPCs (nodies/tenderly) that allow ~100-block windows at any
// depth. 3600 covers the largest gaps observed in production (2878 blocks);
// beyond it we accept the gap but ALWAYS email an alert (see gap handling
// below) so a permanent miss is never silent.
const HEAD_WINDOW = 3600;

// Confirmation depth: scan and advance the cursor only up to head-CONFIRMATIONS,
// not the unconfirmed latest head. A getLogs page that lands on a lagging RPC
// replica (or a shallow reorg) would otherwise return "success but missing the
// tail blocks" while the cursor sails past them — a permanent silent miss.
// ~25 blocks ≈ 50s on Polygon; the cost is that much extra notification delay.
const CONFIRMATIONS = 25;

// Sanity bound: on a non-first run, a single tick's head must not jump more
// than this past the stored cursor. A multi-chain gateway (e.g. 1rpc) can
// mis-route and return another chain's much higher block number; without this
// guard the cursor gets poisoned to that fake head and every later tick reports
// "no new blocks" while the channel is silently dead.
const MAX_HEAD_ADVANCE = 200_000; // ~4.8 days of Polygon blocks

// Per-tick sweep cap. A full HEAD_WINDOW catch-up is 75 sequential getLogs
// pages plus enrichment — that can overrun run-cron's 170s tick timeout, and
// since the cursor only commits at the end, a killed tick makes NO progress
// and the catch-up loops forever. Capping the sweep keeps every tick well
// inside its timeout; the remaining backlog carries to the next ticks
// (a full 3600-block window clears in 3 ticks ≈ 9 minutes).
const MAX_BLOCKS_PER_TICK = 1200;

// ── 改进 I2/I5/I7 的常量 ──

/** V2 adapter (KNOWN_ADAPTERS 注释里的第 5 个):官方 context 只写 storage、
 * 不发 AncillaryDataUpdated —— 事件驱动的盲区(回测 96 信号中 5 个,5.2%)。
 * QuestionReset 在 V2 上照常发,所以用它把 qid 收进轮询名单。 */
const V2_ADAPTER = "0x6a9d222616c90fca5754cd1333cfd9b7fb6a4f74";
const V2_WATCH_TTL_MS = 14 * 24 * 3600_000;
const V2_WATCH_MAX = 40;
const V2_POLLS_PER_TICK = 3;

/** 洪水限流(I2):最近 6h 即时发出的方向性条目数超过阈值(2026-06 世界杯月
 * 单日峰值 320 个信号),非肥尾条目转入汇总队列。 */
const FLOOD_WINDOW_MS = 6 * 3600_000;
const FLOOD_MAX = Number(process.env.CHAIN_WATCH_FLOOD_MAX) || 12;

/** 汇总队列(I2/I5)冲洗条件:攒满 40 条,或最老条目滞留超过 6h。 */
const DIGEST_MAX_AGE_MS = 6 * 3600_000;
const DIGEST_MAX_SIZE = 40;

/** 每 tick 最多做几个盘口核查(I1) —— 每个约 2-4 次代理往返。 */
const EXEC_ANNOTATE_MAX = 6;

function rpcUrls(): string[] {
  const configured = process.env.ONCHAIN_RPC_URLS?.trim();
  if (configured) return configured.split(",").map((u) => u.trim()).filter(Boolean);
  // 2026-07-05 sufe 直连实测:publicnode 近头快但深窗口要 token;nodies/tenderly
  // 支持 600 块深回看(HEAD_WINDOW 的依托);1rpc 免费额度小,只作末位兜底。
  // drpc/polygon-rpc.com/llamarpc/blastapi/blockpi/ankr 均不可用或需 key。
  return [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon-pokt.nodies.app",
    "https://gateway.tenderly.co/public/polygon",
    "https://1rpc.io/matic",
  ];
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  return rpcVia(rpcUrls(), method, params);
}

async function rpcVia<T>(urls: string[], method: string, params: unknown[]): Promise<T> {
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      // AbortSignal.timeout covers the WHOLE request including the body read —
      // a plain controller+clearTimeout would fire clearTimeout right after the
      // headers arrive, leaving res.json() to hang up to undici's ~300s default
      // on a slow-drip RPC and stalling the whole tick past its cron slot.
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as { result?: T; error?: { message?: string } };
      if (json.error || json.result === undefined) {
        throw new Error(json.error?.message ?? `empty ${method} result`);
      }
      return json.result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error(`all RPCs failed for ${method}`);
}

// ── State ──

/** An event whose regex stance was directionless and whose LLM second read
 * yielded NO verdict (CLI unavailable / timeout / budget-skipped). Its
 * fingerprint is already committed, so it will never re-enter byQid on its
 * own — this queue is the only path back to an LLM re-read (e.g. the first
 * hours after deploy, before CLAUDE_CODE_OAUTH_TOKEN lands in .env). */
interface LlmPendingEntry {
  adapter: string;
  kinds: string[];
  title: string | null;
  description: string | null;
  attempts: number;
  firstSeenAt: number;
}

/** I7: a V2-adapter question being polled for storage-only context updates. */
interface V2WatchEntry {
  adapter: string;
  updateCount: number;
  firstSeenAt: number;
  lastPolledAt: number;
}

/** I2/I5: a directional event held back from immediate mail, awaiting the
 * periodic digest. The queue is the durable record — its fingerprint is
 * committed the moment it is queued, so a queued item never re-enters the
 * gate; losing the queue would lose the event, hence it lives in state. */
interface DigestEntry {
  qid: string;
  title: string | null;
  label: string;
  stance: string;
  llmStance: string | null;
  bestAsk: number | null;
  askUsd: number | null;
  marketUrl: string | null;
  /** Why it was digested: "flood" (I2 批量裁定限流) or "blue_no_edge" (I5 🔵收窄). */
  reason: string;
  at: number;
}

interface WatchState {
  lastBlock: number;
  /** qid → fingerprint of the last notified condition (event kinds + update count + stance). */
  notified: Record<string, string>;
  /** qid → LLM re-read queue (see LlmPendingEntry). */
  llmPending: Record<string, LlmPendingEntry>;
  /** qid → V2 storage-poll watchlist (see V2WatchEntry). */
  v2Watch: Record<string, V2WatchEntry>;
  /** Held-back directional events awaiting the digest mail. */
  digestQueue: DigestEntry[];
  /** Epoch-ms timestamps of immediately-mailed directional items (flood detector). */
  mailLog: number[];
}

function statePath(): string {
  const configured = process.env.CHAIN_WATCH_STATE?.trim();
  if (configured) return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  return path.join(process.cwd(), "data", "chain-watch-state.json");
}

function loadState(): WatchState {
  let raw: string;
  try {
    raw = readFileSync(statePath(), "utf8");
  } catch {
    // first run — file absent
    return { lastBlock: 0, notified: {}, llmPending: {}, v2Watch: {}, digestQueue: [], mailLog: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      lastBlock: Number(parsed.lastBlock) || 0,
      notified: parsed.notified && typeof parsed.notified === "object" ? parsed.notified : {},
      llmPending:
        parsed.llmPending && typeof parsed.llmPending === "object" ? parsed.llmPending : {},
      v2Watch: parsed.v2Watch && typeof parsed.v2Watch === "object" ? parsed.v2Watch : {},
      digestQueue: Array.isArray(parsed.digestQueue) ? parsed.digestQueue : [],
      mailLog: Array.isArray(parsed.mailLog) ? parsed.mailLog.filter((t: unknown) => Number.isFinite(t)) : [],
    };
  } catch (err) {
    // File exists but is corrupt (truncated by a crash mid-write). Do NOT
    // silently reset to block 0 — that would re-scan head-3600 and re-notify.
    // Loud-fail so the tick exits non-zero and the operator sees it.
    throw new Error(
      `chain-watch state file ${statePath()} is corrupt: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function saveState(state: WatchState): void {
  writeFileAtomic(statePath(), JSON.stringify(state, null, 1));
}

// ── On-chain question title ──

/** Extract the human question title + description (settlement rules) from the
 * adapter's ancillary data ("q: title: <...>, description: <...> res_data:").
 * Minimal scan-based decode: find the dynamic bytes field of getQuestion's
 * return that looks like ancillary data (layout differs per adapter version).
 * The description feeds the LLM second read — official clarifications often
 * only make sense against the market's own resolution rules. */
async function fetchQuestionMeta(
  adapter: string,
  qid: string
): Promise<{ title: string | null; description: string | null }> {
  try {
    const result = await ethCall(adapter, `${GET_QUESTION_SELECTOR}${qid.slice(2)}`);
    if (!result || result === "0x") return { title: null, description: null };
    const hex = result.slice(2);
    const utf8 = Buffer.from(hex, "hex").toString("utf8");
    const t = utf8.match(/title:\s*([^\n]{4,300}?)(?:,\s*description:|res_data:|$)/);
    const d = utf8.match(/description:\s*([\s\S]{4,2500}?)(?:\s*market_id:|\s*res_data:|$)/);
    return { title: t ? t[1].trim() : null, description: d ? d[1].trim() : null };
  } catch {
    return { title: null, description: null };
  }
}

// ── Main ──

interface Notable {
  qid: string;
  adapter: string;
  kinds: Set<"reset" | "context">;
  title: string | null;
  /** Market settlement rules from ancillary data — context the LLM second
   * read needs (official clarifications often only decide the question when
   * read against the market's own resolution criteria). */
  description: string | null;
  stance: string;
  confidence: string;
  refundClause: boolean;
  excerpt: string | null;
  updateCount: number;
  /** Full chronological official-update sequence — kept so the LLM second
   * reader sees the whole conversation, not just the latest excerpt. */
  updates: OfficialUpdate[];
  /** True only when getOfficialUpdates SUCCEEDED for this item. updates=[]
   * with enriched=false means "text unread" (RPC failure / enrich-budget
   * skip), which the mail gate must treat differently from "no text exists". */
  enriched: boolean;
  /** Second-opinion verdict from headless Claude (via=llm口径, never merged
   * into the regex stance). Undefined = not consulted, null = consulted but
   * failed/unavailable. */
  llm?: LlmStanceVerdict | null;
  /** I1 executability annotation. Undefined = not attempted, null = attempted
   * but Gamma/CLOB unreachable or market unmapped (fail-open). */
  exec?: ExecCheck | null;
}

async function main(): Promise<void> {
  const tickStartedAt = Date.now();
  const state = loadState();
  const rawHead = Number(await rpc<string>("eth_blockNumber", []));
  if (!Number.isFinite(rawHead) || rawHead <= 0) throw new Error(`bad head: ${rawHead}`);

  // Sanity: an implausible head jump (multi-chain gateway mis-routing a higher
  // chain's block number) must not poison the cursor. But a >MAX_HEAD_ADVANCE
  // jump is ALSO what a legitimate multi-day outage looks like — and head only
  // keeps growing, so a bare throw would deadlock the channel forever. On
  // violation, cross-check via a second query with the RPC order reversed: two
  // independent endpoints agreeing means the jump is real (accept it; the
  // HEAD_WINDOW clamp + gap alert handle the backlog), disagreement means a
  // rogue gateway (throw, next tick retries). First run (lastBlock=0) exempt.
  if (state.lastBlock > 0 && rawHead - state.lastBlock > MAX_HEAD_ADVANCE) {
    const crossHead = Number(
      await rpcVia<string>([...rpcUrls()].reverse(), "eth_blockNumber", [])
    );
    if (!Number.isFinite(crossHead) || Math.abs(crossHead - rawHead) > 5_000) {
      throw new Error(
        `implausible head ${rawHead} vs stored lastBlock ${state.lastBlock} (jump ${rawHead - state.lastBlock} > ${MAX_HEAD_ADVANCE}); cross-check head ${crossHead} disagrees — refusing to advance`
      );
    }
    console.warn(
      `[chain-watch] head jump ${rawHead - state.lastBlock} blocks confirmed by cross-check (${crossHead}) — accepting after long downtime`
    );
  }

  // Symmetric low-head guard: a mis-routed head far BELOW the cursor would
  // otherwise sail through the jump check, land in the "no new blocks" skip
  // and exit 0 — monitoring stays green while the channel is silently dead.
  // Loud-fail instead; small negatives (lagging replica within tolerance)
  // still take the harmless skip path below.
  if (state.lastBlock > 0 && rawHead < state.lastBlock - 1_000) {
    throw new Error(
      `implausible head ${rawHead} far below stored lastBlock ${state.lastBlock}; refusing to treat as "no new blocks"`
    );
  }

  // Only scan up to a confirmed depth to avoid reorg/replica-lag silent misses.
  const head = rawHead - CONFIRMATIONS;
  const idealFrom = state.lastBlock > 0 ? state.lastBlock + 1 : head - HEAD_WINDOW;
  const from = Math.max(idealFrom, head - HEAD_WINDOW);
  const gap = from > idealFrom ? from - idealFrom : 0;
  if (from > head) {
    console.log(JSON.stringify({ mode: "chain-watch", head, skipped: "no new blocks" }));
    return;
  }

  // Cap the sweep so a catch-up tick still finishes (and commits its cursor)
  // inside run-cron's tick timeout; the rest of the backlog carries over.
  const to = Math.min(head, from + MAX_BLOCKS_PER_TICK - 1);

  // Fetch in ≤48-block windows — the strictest free-tier getLogs cap seen
  // (1rpc allows 50; publicnode ~127 near the head). A window that fails on
  // every RPC stops the sweep, but progress up to it is kept: the swept
  // range is processed and persisted, the rest retried next tick — so one
  // bad page no longer voids the whole tick (that's how 12% of blocks got
  // permanently skipped in the first day of deployment).
  // Soft time budgets inside run-cron's 170s SIGTERM: block/page caps bound
  // the WORK but not the TIME (a black-holed endpoint burns 15s per URL per
  // page; enrichment burns up to 10s per URL per ethCall). If the tick is
  // killed before commitState, no progress persists and the same slow range
  // is retried forever. Budgets guarantee every tick reaches send+commit.
  const SWEEP_BUDGET_MS = 100_000;
  const ENRICH_BUDGET_MS = 140_000;
  const elapsed = () => Date.now() - tickStartedAt;

  const logs: Array<{ address: string; topics: string[] }> = [];
  const WINDOW = 48;
  let sweptTo = from - 1;
  let sweepError: string | null = null;
  for (let start = from; start <= to; start += WINDOW) {
    if (elapsed() > SWEEP_BUDGET_MS) {
      sweepError = `sweep stopped at time budget (${SWEEP_BUDGET_MS / 1000}s); resuming next tick`;
      break;
    }
    const end = Math.min(start + WINDOW - 1, to);
    try {
      const page = await rpc<Array<{ address: string; topics: string[] }>>("eth_getLogs", [
        {
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
          address: KNOWN_ADAPTERS,
          topics: [[TOPIC_QUESTION_RESET, TOPIC_ANCILLARY_UPDATED]],
        },
      ]);
      logs.push(...page);
      sweptTo = end;
    } catch (err) {
      sweepError = err instanceof Error ? err.message : String(err);
      break;
    }
  }
  if (sweptTo < from) {
    // Zero progress — keep old state untouched and exit non-zero so the
    // heartbeat marker/ping is NOT refreshed for this tick.
    throw new Error(`sweep made no progress: ${sweepError}`);
  }

  // Group events by questionID
  const byQid = new Map<string, Notable>();
  for (const log of logs) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    const qid = log.topics?.[1]?.toLowerCase();
    if (!qid) continue;
    const kind = topic0 === TOPIC_QUESTION_RESET ? "reset" : topic0 === TOPIC_ANCILLARY_UPDATED ? "context" : null;
    if (!kind) continue;
    if (!byQid.has(qid)) {
      byQid.set(qid, {
        qid,
        adapter: log.address.toLowerCase(),
        kinds: new Set(),
        title: null,
        description: null,
        stance: "none",
        confidence: "none",
        refundClause: false,
        excerpt: null,
        updateCount: 0,
        updates: [],
        enriched: false,
      });
    }
    byQid.get(qid)!.kinds.add(kind);
  }

  // Enrich each with title + official context read straight from the chain.
  // Past the time budget the remaining items go out un-enriched (title=null,
  // stance none) — a degraded but timely alert beats a tick killed by timeout
  // with nothing sent and no progress committed.
  for (const item of byQid.values()) {
    if (elapsed() > ENRICH_BUDGET_MS) {
      console.warn(
        `[chain-watch] enrichment stopped at time budget (${ENRICH_BUDGET_MS / 1000}s); remaining events notify without title/context`
      );
      break;
    }
    const meta = await fetchQuestionMeta(item.adapter, item.qid);
    item.title = meta.title;
    item.description = meta.description;
    try {
      const { updates } = await getOfficialUpdates({ resolvedBy: item.adapter, questionID: item.qid });
      item.enriched = true;
      item.updateCount = updates.length;
      item.updates = updates;
      item.refundClause = detectRefundClause(updates.map((u) => u.text));
      for (let i = updates.length - 1; i >= 0; i -= 1) {
        const classified = stanceFromText(updates[i].text);
        if (isDirectionalStance(classified.stance)) {
          item.stance = classified.stance;
          item.confidence = classified.confidence;
          item.excerpt = updates[i].text.slice(0, 400);
          break;
        }
      }
      if (item.excerpt == null && updates.length > 0) {
        const latest = updates[updates.length - 1];
        const classified = stanceFromText(latest.text);
        item.stance = classified.stance;
        item.confidence = classified.confidence;
        item.excerpt = latest.text.slice(0, 400);
      }
    } catch {
      // context unreadable — still notify on the reset event itself
    }
  }

  // ── I7: V2 storage 轮询兜底 ──
  // V2 adapter 只写 storage 不发 AncillaryDataUpdated。凡在 V2 上见过事件的
  // qid 进入 v2Watch;每 tick 轮询最旧的几个,getUpdates 数量增加即视为一次
  // context 事件,合入 byQid 走同一套闸门与指纹去重。14 天 TTL,40 条上限。
  const nowMs = Date.now();
  for (const item of byQid.values()) {
    if (item.adapter !== V2_ADAPTER) continue;
    const prev = state.v2Watch[item.qid];
    state.v2Watch[item.qid] = {
      adapter: item.adapter,
      updateCount: Math.max(item.updateCount, prev?.updateCount ?? 0),
      firstSeenAt: prev?.firstSeenAt ?? nowMs,
      lastPolledAt: nowMs,
    };
  }
  for (const [qid, w] of Object.entries(state.v2Watch)) {
    if (nowMs - w.firstSeenAt > V2_WATCH_TTL_MS) delete state.v2Watch[qid];
  }
  {
    const keys = Object.keys(state.v2Watch);
    if (keys.length > V2_WATCH_MAX) {
      for (const k of keys.slice(0, keys.length - V2_WATCH_MAX)) delete state.v2Watch[k];
    }
  }
  let v2Polled = 0;
  const v2ToPoll = Object.entries(state.v2Watch)
    .filter(([qid]) => !byQid.has(qid))
    .sort((a, b) => a[1].lastPolledAt - b[1].lastPolledAt)
    .slice(0, V2_POLLS_PER_TICK);
  for (const [qid, w] of v2ToPoll) {
    if (elapsed() > ENRICH_BUDGET_MS) break;
    w.lastPolledAt = Date.now();
    try {
      const { updates } = await getOfficialUpdates({ resolvedBy: w.adapter, questionID: qid });
      v2Polled += 1;
      if (updates.length <= w.updateCount) continue;
      w.updateCount = updates.length;
      const meta = await fetchQuestionMeta(w.adapter, qid);
      const item: Notable = {
        qid,
        adapter: w.adapter,
        kinds: new Set(["context"]),
        title: meta.title,
        description: meta.description,
        stance: "none",
        confidence: "none",
        refundClause: detectRefundClause(updates.map((u) => u.text)),
        excerpt: null,
        updateCount: updates.length,
        updates,
        enriched: true,
      };
      for (let i = updates.length - 1; i >= 0; i -= 1) {
        const classified = stanceFromText(updates[i].text);
        if (isDirectionalStance(classified.stance)) {
          item.stance = classified.stance;
          item.confidence = classified.confidence;
          item.excerpt = updates[i].text.slice(0, 400);
          break;
        }
      }
      if (item.excerpt == null && updates.length > 0) {
        const latest = updates[updates.length - 1];
        const classified = stanceFromText(latest.text);
        item.stance = classified.stance;
        item.confidence = classified.confidence;
        item.excerpt = latest.text.slice(0, 400);
      }
      byQid.set(qid, item);
    } catch {
      // RPC 瞬断 — lastPolledAt 已推进,下轮轮询别的条目,此条稍后重试
    }
  }

  // Decide what's notification-worthy and not already notified. Fingerprints
  // are computed but NOT committed to state.notified yet — they're only
  // persisted after the email actually goes out (at-least-once), so an SMTP
  // hiccup can't silently swallow a real dispute event.
  const pendingFingerprints = new Map<string, string>();
  const notable = [...byQid.values()].filter((item) => {
    const fingerprint = `${[...item.kinds].sort().join("+")}:${item.updateCount}:${item.stance}`;
    if (state.notified[item.qid] === fingerprint) return false;
    pendingFingerprints.set(item.qid, fingerprint);
    return true;
  });

  // Commit progress + notified fingerprints, then bound the map. Called only
  // after any required email send has succeeded. delete-then-set moves a
  // refreshed qid to the END of the key order — a plain overwrite keeps its
  // old position, and the prune below would then evict the fingerprint we
  // just wrote (insertion-order prune must behave like least-recently-used).
  const commitState = () => {
    for (const [qid, fp] of pendingFingerprints) {
      delete state.notified[qid];
      state.notified[qid] = fp;
    }
    state.lastBlock = sweptTo;
    const keys = Object.keys(state.notified);
    if (keys.length > 500) {
      for (const k of keys.slice(0, keys.length - 500)) delete state.notified[k];
    }
    saveState(state);
  };

  // ── 发信闸门(2026-07-08 收窄):只有"方向性"事件才配打扰邮箱 ──
  // 生产判卷(74 事件 4 天)证明 97.3% 的链上争议事件无官方方向且不可执行,
  // "任何新事件都发信"只产生噪音。收窄后:
  //   1. 正则判出方向(isDirectionalStance) → 直接放行(32/32 口径的快路径);
  //   2. 正则无方向但存在官方文本 → 交给 headless Claude 复核完整 update
  //      时间序(修 Kelce 型"定义式裁定"假阴性),LLM 判出方向才放行,结果标
  //      via=llm 与正则口径隔离;
  //   3. 官方文本读取失败/预算跳过(enriched=false) → 降级发信(旧行为):
  //      cursor 即将永久越过该块,而官方最终裁定往往是市场的最后一个事件,
  //      静默等于永久漏报;
  //   4. 链上确实无官方文本(纯 QuestionReset)与 LLM 亦判无方向的 → 只写
  //      日志不发信。
  // LLM 无定论(CLI 不可用/超时/预算耗尽) → 该事件按纯正则结果处理(fail-open
  // 到规则收窄,绝不回到全量发信,也绝不吞掉正则已判出的方向),同时进入持久
  // llmPending 队列,后续 tick LLM 恢复后补判(如部署初期 token 未配的窗口)。
  // 所有 notable 无论发信与否都照常 commitState:指纹含 updateCount+stance,
  // 官方后续再发文本时指纹必变,事件仍会回来重新过闸。
  const TICK_KILL_MS = 170_000; // run-cron.sh 的 timeout SIGTERM
  const SEND_MARGIN_MS = 12_000; // 为 sendMail+commitState 保留的尾部余量
  const LLM_MIN_CALL_MS = 15_000; // 剩余预算低于此值不再发起新调用
  const llmBudgetLeftMs = () => TICK_KILL_MS - SEND_MARGIN_MS - elapsed();
  // 单次调用的超时被钳到剩余预算内:一个 149s 才开始的 60s 调用会越过 170s
  // SIGTERM,把整个 tick(连同待发的正则方向邮件和 commitState)一起杀掉。
  const consultLlm = (item: {
    qid: string;
    title: string | null;
    description: string | null;
    updates: OfficialUpdate[];
    stance: string;
    confidence: string;
    updateCount: number;
  }): Promise<LlmStanceVerdict | null> =>
    classifyStanceWithLlm({
      title: item.title,
      description: item.description,
      updates: item.updates,
      regexStance: { stance: item.stance, confidence: item.confidence },
      cacheKey: `${item.qid}:${item.updateCount}`,
      timeoutMs: Math.min(60_000, llmBudgetLeftMs()),
    });

  const mailable: Notable[] = [];
  let llmSkipped = 0;

  // A. 上轮遗留的 LLM 补判队列:本轮有新事件的 qid 交回正常闸门处理(若又
  //    失败会重新入队);其余在预算内逐个补判,有定论(无论方向与否)即出队。
  for (const [qid, p] of Object.entries(state.llmPending)) {
    if (byQid.has(qid)) {
      delete state.llmPending[qid];
      continue;
    }
    if (llmBudgetLeftMs() < LLM_MIN_CALL_MS) break;
    let updates: OfficialUpdate[] = [];
    try {
      ({ updates } = await getOfficialUpdates({ resolvedBy: p.adapter, questionID: qid }));
    } catch {
      // RPC 瞬断 — 留队,下轮再试(attempts 照常累积,防永久滞留)
    }
    if (updates.length > 0) {
      const latest = stanceFromText(updates[updates.length - 1].text);
      const revived: Notable = {
        qid,
        adapter: p.adapter,
        kinds: new Set(p.kinds.filter((k): k is "reset" | "context" => k === "reset" || k === "context")),
        title: p.title,
        description: p.description ?? null,
        stance: latest.stance,
        confidence: latest.confidence,
        refundClause: detectRefundClause(updates.map((u) => u.text)),
        excerpt: updates[updates.length - 1].text.slice(0, 400),
        updateCount: updates.length,
        updates,
        enriched: true,
      };
      if (isDirectionalStance(latest.stance)) {
        // 补判期间官方追加了方向性文本(罕见,通常伴随新事件走正常闸门)
        delete state.llmPending[qid];
        mailable.push(revived);
        continue;
      }
      const verdict = await consultLlm(revived);
      if (verdict) {
        delete state.llmPending[qid];
        if (isDirectionalStance(verdict.stance)) {
          revived.llm = verdict;
          mailable.push(revived);
        }
        continue;
      }
    }
    p.attempts += 1;
    if (p.attempts >= 16 || Date.now() - p.firstSeenAt > 48 * 3600_000) {
      console.warn(`[chain-watch] llmPending ${qid} 放弃补判(attempts=${p.attempts})`);
      delete state.llmPending[qid];
    }
  }

  // B. 本轮事件闸门。回测结论(96 信号 train/holdout):正则方向的无偏胜率仅
  // 63-70%(模板文本假方向是主要亏损源),LLM 复核同向(置信≥medium)的子集
  // 12/12 全胜且 holdout 19/19 正确拒判噪音——所以正则方向的事件也统一送
  // LLM 复核:不拦截发信(32/32 口径的哨兵语义保留,LLM 挂了照发),但复核
  // 结果决定标题分级(🟢双确认 / 🟠LLM拒判警示),让邮箱里直接可分诊。
  // LLM 侧独立放行的方向判读要求置信 ≥medium(low 是回测里唯一漏网亏损)。
  for (const item of notable) {
    const hasText = item.updates.length > 0;
    if (!item.enriched && !hasText) {
      mailable.push(item); // 规则 3:读取失败 → 降级发信
      continue;
    }
    if (hasText) {
      if (llmBudgetLeftMs() < LLM_MIN_CALL_MS) {
        llmSkipped += 1;
      } else {
        item.llm = await consultLlm(item);
      }
    }
    const regexDirectional = isDirectionalStance(item.stance);
    const llmDirectional =
      item.llm != null && isDirectionalStance(item.llm.stance) && item.llm.confidence !== "low";
    if (regexDirectional || llmDirectional) {
      mailable.push(item);
      continue;
    }
    if (hasText && item.llm == null) {
      // 无定论(失败/预算跳过,区别于"LLM 判了但无方向") → 入补判队列
      state.llmPending[item.qid] = {
        adapter: item.adapter,
        kinds: [...item.kinds],
        title: item.title,
        description: item.description,
        attempts: 0,
        firstSeenAt: Date.now(),
      };
    }
  }
  // 队列封顶:CLI 长期不可用时不能无界增长(淘汰最老的)
  {
    const pendingKeys = Object.keys(state.llmPending);
    if (pendingKeys.length > 50) {
      for (const k of pendingKeys.slice(0, pendingKeys.length - 50)) delete state.llmPending[k];
    }
  }
  const suppressedItems = notable.filter((n) => !mailable.includes(n));
  const suppressed = suppressedItems.length;
  const degraded = mailable.filter((n) => !n.enriched).length;
  if (suppressed > 0) {
    console.log(
      JSON.stringify({
        mode: "chain-watch-suppressed",
        items: suppressedItems.map((i) => ({
          qid: i.qid.slice(0, 12),
          title: i.title?.slice(0, 60) ?? null,
          stance: i.stance,
          llm:
            i.llm === undefined
              ? i.updates.length === 0
                ? "no_text"
                : "not_consulted"
              : i.llm === null
                ? "unavailable"
                : i.llm.stance,
        })),
      })
    );
  }

  // ── I1: 盘口可执行性注解 ──
  // 回测实锤:87% 的方向性通知在信号后 2h 内连 $100 真实成交都没有。发信前
  // 对前几项做 Gamma/CLOB 核查(经代理,fail-open),把"能不能买、什么价、多深"
  // 直接写进邮件,并供 I3/I5 的分级与路由使用。
  let execChecked = 0;
  for (const item of mailable.slice(0, EXEC_ANNOTATE_MAX)) {
    if (llmBudgetLeftMs() < 10_000) break;
    const effStance = isDirectionalStance(item.stance)
      ? item.stance
      : item.llm && isDirectionalStance(item.llm.stance)
        ? item.llm.stance
        : null;
    if (!effStance) continue;
    item.exec = await checkExecutability({ adapter: item.adapter, qid: item.qid, stance: effStance });
    execChecked += 1;
  }

  // 标题即分诊:最高优先级事件的 stance·置信度直接进主题行,一眼可判是否
  // 值得打开。回测背书的分级(15 个月/2,182 信号/954 次判读):
  //   🟢🔥 肥尾候选(双确认∧争议中/深价位,全部利润的来源,+21.3%/笔档内)
  // > 🟢 双确认(其余,含尾价 carry)
  // > 🟠 官方方向但 LLM 拒判/无定论/边界澄清(拒判≈硬币;无定论 -67.4% 最毒)
  // > 🔵 LLM 单独判读(95% 胜率但 -0.1%/笔,人工研判素材)> ⚪ 降级。
  const polarity = (stance: string): string => {
    if (/YES$/i.test(stance)) return "+";
    if (/NO$/i.test(stance)) return "-";
    return stance; // resolve_to_* 等:要求字面一致
  };
  // I4 规则层:LLM 判"事件未决"(eventStatus=pending)而方向来自 leans_*(资格/
  // 边界式推断)→ 不给 🟢。回测里 🟢 档全部 7 笔 -100% 都是"未决事件的边界/资格
  // 澄清被误读成方向"。只降标签、照发邮件,肥尾告警本身不丢;LLM_BOUNDARY_GUARD=off
  // 可关闭(A/B 用)。
  const boundaryGuardOn = (process.env.LLM_BOUNDARY_GUARD ?? "").trim().toLowerCase() !== "off";
  const boundaryPending = (n: Notable): boolean =>
    boundaryGuardOn &&
    n.llm?.eventStatus === "pending" &&
    (/^leans_/i.test(n.llm.stance) || /^leans_/i.test(n.stance));
  const priorityOf = (n: Notable): { rank: number; label: string } => {
    const llmDir = n.llm != null && isDirectionalStance(n.llm.stance) && n.llm.confidence !== "low";
    if (isDirectionalStance(n.stance)) {
      if (llmDir && polarity(n.llm!.stance) === polarity(n.stance)) {
        if (boundaryPending(n))
          return { rank: 1, label: `🟠 官方方向 ${n.stance}·${n.confidence} (⚠️边界澄清·事件未决)` };
        // I3 🟢 内部再分级:入场价离 1 越远(市场重仓反向)越像肥尾;尾价 ≥0.97
        // 只是薄利 carry。无盘口数据时退化为"是否处于争议(reset)"判断。
        const ask = n.exec?.bestAsk ?? null;
        if ((ask != null && ask <= 0.9) || (ask == null && n.kinds.has("reset")))
          return { rank: 0, label: `🟢🔥 肥尾候选 ${n.stance}·${n.confidence}` };
        if (ask != null && ask >= 0.97)
          return { rank: 0, label: `🟢 双确认 ${n.stance}·${n.confidence} (尾价carry)` };
        return { rank: 0, label: `🟢 双确认 ${n.stance}·${n.confidence}` };
      }
      if (n.llm && !isDirectionalStance(n.llm.stance))
        return { rank: 1, label: `🟠 官方方向 ${n.stance}·${n.confidence} (LLM拒判⚠)` };
      return { rank: 1, label: `🟠 官方方向 ${n.stance}·${n.confidence}` };
    }
    if (llmDir) return { rank: 2, label: `🔵 LLM判读 ${n.llm!.stance}·${n.llm!.confidence}` };
    if (!n.enriched) return { rank: 3, label: `⚪ 降级(文本读取失败)` };
    return { rank: 4, label: `⚪ ${n.stance}` };
  };
  const isFatTail = (n: Notable): boolean => priorityOf(n).label.includes("肥尾候选");

  // ── I5 🔵收窄 + I2 洪水限流:即时邮件 vs 汇总队列 ──
  const routeNow = Date.now();
  state.mailLog = state.mailLog.filter((t) => routeNow - t < FLOOD_WINDOW_MS);
  const floodActive = state.mailLog.length >= FLOOD_MAX;
  const immediate: Notable[] = [];
  const digested: Array<{ n: Notable; reason: string }> = [];
  for (const n of mailable) {
    const pr = priorityOf(n);
    // I5:🔵(纯 LLM 判读)只有"争议中"或"盘口显示有肉且可执行"才配即时打扰。
    // 回测 🔵 档 95% 胜率却 -0.1%/笔(0.99 薄 carry),模板簇判向率 67% 全不可执行。
    if (pr.rank === 2) {
      const hasEdge =
        n.kinds.has("reset") ||
        (n.exec != null && n.exec.bestAsk != null && n.exec.bestAsk < 0.97 && n.exec.executable);
      if (!hasEdge) {
        digested.push({ n, reason: "blue_no_edge" });
        continue;
      }
    }
    // I2:批量裁定洪水(2026-06 单月 690 信号/单日峰 320)中,只有肥尾候选与
    // 降级告警(enriched=false,安全兜底语义不能延迟)保持即时,其余进汇总。
    if (floodActive && pr.rank <= 2 && !isFatTail(n) && n.enriched) {
      digested.push({ n, reason: "flood" });
      continue;
    }
    immediate.push(n);
  }
  for (const { n, reason } of digested) {
    state.digestQueue.push({
      qid: n.qid,
      title: n.title,
      label: priorityOf(n).label,
      stance: n.stance,
      llmStance: n.llm?.stance ?? null,
      bestAsk: n.exec?.bestAsk ?? null,
      askUsd: n.exec?.askUsdNear ?? null,
      marketUrl: n.exec?.marketUrl ?? null,
      reason,
      at: routeNow,
    });
  }
  if (state.digestQueue.length > 100) {
    state.digestQueue.splice(0, state.digestQueue.length - 100);
  }

  // ── I6: 🟢 自动登记 paper_trades(前瞻虚拟持仓,再也不用事后重建回测)──
  // localDb 惰性加载:chain-watch 的承诺是"无 sqlite 也能跑",登记失败只记日志。
  let paperRegistered = 0;
  if ((process.env.PAPER_TRADES_AUTO ?? "").trim().toLowerCase() !== "off") {
    for (const n of mailable) {
      if (priorityOf(n).rank !== 0) continue;
      const e = n.exec;
      if (!e || e.closed || !e.fill100) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const db = require("../lib/localDb") as typeof import("../lib/localDb");
        if (db.listOpenPaperTrades().some((t) => t.tokenId === e.tokenId)) continue;
        db.insertPaperTrade({
          conditionId: e.conditionId,
          tokenId: e.tokenId,
          marketQuestion: e.question,
          outcomeBought: e.outcome,
          marketUrl: e.marketUrl,
          endDate: e.endDate,
          usdAmount: e.fill100.usd,
          shares: e.fill100.shares,
          avgFillPrice: e.fill100.avgPrice,
          worstFillPrice: e.fill100.worstPrice,
          fills: e.fill100.fills,
        });
        paperRegistered += 1;
      } catch (err) {
        console.warn(
          `[chain-watch] paper trade 登记失败(${n.qid.slice(0, 10)}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // ── I2: 汇总队列冲洗(攒满 DIGEST_MAX_SIZE 条,或最老条目滞留超 6h)──
  // 独立于即时邮件的 best-effort:失败保留队列下轮重试,绝不阻塞 cursor 推进。
  const flushDigest = async (): Promise<void> => {
    const q = state.digestQueue;
    if (q.length === 0) return;
    const oldest = Math.min(...q.map((d) => d.at));
    if (q.length < DIGEST_MAX_SIZE && Date.now() - oldest < DIGEST_MAX_AGE_MS) return;
    const items = q.slice(0, 60);
    const digestRows = items
      .map(
        (d) => `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:13px">
      ${escapeHtml(d.title ?? d.qid)}<br>
      <span style="font-size:12px;color:#888">${escapeHtml(d.label)} · ${
        d.bestAsk != null ? `价${d.bestAsk.toFixed(3)} · 深$${Math.round(d.askUsd ?? 0)}` : "盘口未核对"
      } · ${new Date(d.at).toISOString().slice(5, 16)}Z${
        d.marketUrl ? ` · <a href="${d.marketUrl}">市场</a>` : ""
      }</span>
    </td></tr>`
      )
      .join("\n");
    try {
      await sendMail({
        subject: `[PredEdge链上] 📦 低优先级方向事件汇总 ${items.length} 项`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:640px"><p>洪水限流(I2)/🔵收窄(I5)期间积累的方向性事件,汇总如下(未即时打扰):</p><table style="width:100%;border-collapse:collapse">${digestRows}</table></div>`,
        text: items.map((d) => `${d.title ?? d.qid} | ${d.label} | ask=${d.bestAsk ?? "?"} 深$${d.askUsd ?? "?"}`).join("\n"),
      });
      state.digestQueue = q.slice(items.length);
      saveState(state);
    } catch (err) {
      console.error(
        `[chain-watch] digest 发送失败(队列保留,下轮重试): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const logSummary = (notified: number) => {
    console.log(
      JSON.stringify({
        mode: "chain-watch",
        from,
        to: sweptTo,
        events: logs.length,
        notified,
        queued_digest: digested.length,
        digest_queue: state.digestQueue.length,
        flood: floodActive || undefined,
        suppressed,
        degraded,
        exec_checked: execChecked,
        paper_registered: paperRegistered || undefined,
        v2_watch: Object.keys(state.v2Watch).length || undefined,
        v2_polled: v2Polled || undefined,
        llm_cli_calls: llmCliCallCount(),
        llm_skipped: llmSkipped,
        llm_backed: mailable.filter((n) => n.llm && isDirectionalStance(n.llm.stance)).length,
        llm_pending: Object.keys(state.llmPending).length,
        gap,
        sweep_error: sweepError ?? undefined,
      })
    );
  };

  if (immediate.length === 0) {
    // 无需即时邮件(可能全部进了汇总队列):cursor+指纹+队列先落盘(队列就是
    // digested 条目的持久记录),再 best-effort 处理 gap 告警与队列冲洗。
    commitState();
    if (gap > 0) {
      try {
        await sendMail({
          subject: `[PredEdge 链上] ⚠️ 永久漏扫 ${gap} 个块`,
          html: `<div style="font-family:system-ui,sans-serif;max-width:640px"><p style="color:#d97706">⚠️ chain-watch 停机追赶超出回看窗口(${HEAD_WINDOW} 块),块 ${idealFrom}–${from - 1}(共 ${gap} 个)未被扫描且不可回补。若此区间有争议事件,可能已漏报。</p><p style="font-size:12px;color:#888">建议核对 Polymarket 争议区,或考虑接入更深回看能力的付费 RPC。</p></div>`,
          text: `chain-watch 永久漏扫 ${gap} 个块(${idealFrom}–${from - 1});停机超出回看窗口 ${HEAD_WINDOW}。`,
        });
      } catch (err) {
        console.error(`[chain-watch] gap alert send failed (gap=${gap}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await flushDigest();
    logSummary(0);
    return;
  }

  immediate.sort((a, b) => priorityOf(a).rank - priorityOf(b).rank);
  const top = immediate[0];
  const topTitle = (top.title ?? top.qid).slice(0, 48);
  // I1 主题行注解:价与深度直接可见,"深$"不足 $100 挂 ⚠(87% 的通知属于此类)。
  const topExecBit = top.exec
    ? top.exec.bestAsk != null
      ? ` | 价${top.exec.bestAsk.toFixed(2)} 深$${Math.round(top.exec.askUsdNear)}${top.exec.executable ? "" : "⚠"}`
      : " | 无盘口⚠"
    : "";
  const subject = `[PredEdge链上] ${priorityOf(top).label}${topExecBit} | ${topTitle}${immediate.length > 1 ? ` 等${immediate.length}个` : ""}`;

  const rows = immediate
    .map((n) => {
      const searchUrl = n.title
        ? `https://polymarket.com/search?q=${encodeURIComponent(n.title.slice(0, 80))}`
        : `https://polymarket.com`;
      const kindLabel = [...n.kinds]
        .map((k) => (k === "reset" ? "争议重置(QuestionReset)" : "官方context更新"))
        .join(" + ");
      const degradedTag = !n.enriched
        ? ` · <b style="color:#d97706">⚠️ 官方文本读取失败(降级通知,方向未知)</b>`
        : "";
      const stanceLine = isDirectionalStance(n.stance)
        ? `<b style="color:#d97706">官方方向: ${escapeHtml(n.stance)} (${escapeHtml(n.confidence)})</b>`
        : `正则立场: ${escapeHtml(n.stance)} (${escapeHtml(n.confidence)})`;
      // LLM 判读呈现:与正则并列,明确标 via=llm——这是判读增强,不是 32/32
      // 口径的官方文本信号,依据引用原文供人工核对。
      const llmLine = n.llm
        ? isDirectionalStance(n.llm.stance)
          ? `<div style="margin-top:2px"><b style="color:#2563eb">LLM 判读: ${escapeHtml(n.llm.stance)} (${escapeHtml(n.llm.confidence)}, via=llm)</b>${n.llm.eventStatus ? `<span style="font-size:12px;color:#888"> · 事件${n.llm.eventStatus === "decided" ? "已决" : n.llm.eventStatus === "pending" ? "未决⚠" : "状态不明"}</span>` : ""}${n.llm.evidence ? `<div style="font-size:12px;color:#666">依据: "${escapeHtml(n.llm.evidence)}"</div>` : ""}${n.llm.reasoning ? `<div style="font-size:12px;color:#888">${escapeHtml(n.llm.reasoning)}</div>` : ""}</div>`
          : `<div style="margin-top:2px;font-size:12px;color:#888">LLM 判读: ${escapeHtml(n.llm.stance)} (${escapeHtml(n.llm.confidence)})</div>`
        : "";
      // I1 盘口行:能买什么、什么价、多深、直达链接;未核查/失败时如实说明。
      const execLine = n.exec
        ? n.exec.bestAsk != null
          ? `<div style="margin-top:2px;font-size:13px"><b style="color:${n.exec.executable ? "#16a34a" : "#d97706"}">盘口: 买 ${escapeHtml(n.exec.outcome)} @${n.exec.bestAsk.toFixed(3)}${n.exec.bestBid != null ? ` (bid ${n.exec.bestBid.toFixed(3)})` : ""} · 近档深度 $${Math.round(n.exec.askUsdNear)}${n.exec.executable ? "" : " (<$100 难成交)"}</b>${n.exec.fill100 ? ` · $100 市价单均价 ${n.exec.fill100.avgPrice.toFixed(3)}` : ""}${n.exec.marketUrl ? ` · <a href="${n.exec.marketUrl}">直达市场</a>` : ""}</div>`
          : `<div style="margin-top:2px;font-size:13px;color:#d97706">盘口: 空(当前无卖单)${n.exec.marketUrl ? ` · <a href="${n.exec.marketUrl}">直达市场</a>` : ""}</div>`
        : n.exec === null
          ? `<div style="margin-top:2px;font-size:12px;color:#888">盘口未核对(Gamma/CLOB 不可达或市场未匹配)</div>`
          : "";
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #333">
          <div style="font-weight:600">${escapeHtml(n.title ?? n.qid)}</div>
          <div style="font-size:12px;color:#888">${kindLabel} · updates=${n.updateCount}${n.refundClause ? " · ⚠️refund条款" : ""}${degradedTag}</div>
          <div style="margin-top:4px">${stanceLine}</div>
          ${llmLine}
          ${execLine}
          ${n.excerpt ? `<div style="font-size:12px;color:#aaa;margin-top:4px">"${escapeHtml(n.excerpt)}"</div>` : ""}
          <div style="margin-top:4px"><a href="${searchUrl}">在 Polymarket 搜索</a> · qid ${escapeHtml(n.qid.slice(0, 10))}…</div>
        </td></tr>`;
    })
    .join("\n");

  const html = `<div style="font-family:system-ui,sans-serif;max-width:640px">
    <p>链上监听在块 ${from}–${sweptTo} 发现方向性争议事件:</p>
    ${gap > 0 ? `<p style="color:#d97706">⚠️ 距上次运行跳过了 ${gap} 个块(停机追赶超出免费 RPC 回看窗口)。</p>` : ""}
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    ${digested.length > 0 ? `<p style="font-size:12px;color:#888">另有 ${digested.length} 个低优先级方向事件进入汇总队列(当前 ${state.digestQueue.length} 项待汇总)。</p>` : ""}
    ${suppressed > 0 ? `<p style="font-size:12px;color:#888">另有 ${suppressed} 个无方向争议事件已按收窄策略静默(仅记日志)。</p>` : ""}
    <p style="font-size:12px;color:#888">盘口注解为发信时刻快照,下单前请再核对;LLM 判读(via=llm)是文本解读增强,非官方文本口径(32/32)本身,请核对引用原文。</p>
  </div>`;

  const text = immediate
    .map((n) => {
      const llmBit = n.llm && isDirectionalStance(n.llm.stance) ? ` llm=${n.llm.stance}(${n.llm.confidence})` : "";
      const execBit = n.exec?.bestAsk != null ? ` ask=${n.exec.bestAsk.toFixed(3)} depth$${Math.round(n.exec.askUsdNear)}` : "";
      return `${n.title ?? n.qid} | ${[...n.kinds].join("+")} | stance=${n.stance}(${n.confidence})${llmBit}${execBit}${n.refundClause ? " REFUND" : ""}`;
    })
    .join("\n");

  // At-least-once: send FIRST. If this throws, we fall through to the top-level
  // catch → exit 1 → state is NOT committed → next tick re-scans the same range
  // (cursor unchanged) and retries. A duplicate email on a later success is the
  // accepted trade-off; a permanently-lost dispute alert is not.
  await sendMail({ subject, html, text });
  // 洪水检测计数:只统计成功即时发出的方向性条目(rank≤2)。
  for (const n of immediate) {
    if (priorityOf(n).rank <= 2) state.mailLog.push(routeNow);
  }
  commitState();
  await flushDigest();
  logSummary(immediate.length);
}

main().catch((err) => {
  console.error(`[chain-watch] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
