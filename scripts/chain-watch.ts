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
 * No Gamma/CLOB access → no prices, depth, or market URLs; the email carries
 * the question title, the official text excerpt, the classified direction,
 * and a Polymarket search link. State (block cursor + notified set) lives in
 * a JSON file so this script needs no sqlite and no Next.js runtime.
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
  attempts: number;
  firstSeenAt: number;
}

interface WatchState {
  lastBlock: number;
  /** qid → fingerprint of the last notified condition (event kinds + update count + stance). */
  notified: Record<string, string>;
  /** qid → LLM re-read queue (see LlmPendingEntry). */
  llmPending: Record<string, LlmPendingEntry>;
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
    return { lastBlock: 0, notified: {}, llmPending: {} }; // first run — file absent
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      lastBlock: Number(parsed.lastBlock) || 0,
      notified: parsed.notified && typeof parsed.notified === "object" ? parsed.notified : {},
      llmPending:
        parsed.llmPending && typeof parsed.llmPending === "object" ? parsed.llmPending : {},
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

/** Extract the human question title from the adapter's ancillary data
 * ("q: title: <...>, description: ..."). Minimal scan-based decode: find the
 * dynamic bytes field of getQuestion's return that looks like ancillary
 * data (layout differs per adapter version). */
async function fetchQuestionTitle(adapter: string, qid: string): Promise<string | null> {
  try {
    const result = await ethCall(adapter, `${GET_QUESTION_SELECTOR}${qid.slice(2)}`);
    if (!result || result === "0x") return null;
    const hex = result.slice(2);
    const utf8 = Buffer.from(hex, "hex").toString("utf8");
    const m = utf8.match(/title:\s*([^\n]{4,300}?)(?:,\s*description:|res_data:|$)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// ── Main ──

interface Notable {
  qid: string;
  adapter: string;
  kinds: Set<"reset" | "context">;
  title: string | null;
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
    item.title = await fetchQuestionTitle(item.adapter, item.qid);
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
    updates: OfficialUpdate[];
    stance: string;
    confidence: string;
    updateCount: number;
  }): Promise<LlmStanceVerdict | null> =>
    classifyStanceWithLlm({
      title: item.title,
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

  // B. 本轮事件闸门
  for (const item of notable) {
    if (isDirectionalStance(item.stance)) {
      mailable.push(item);
      continue;
    }
    if (item.updates.length === 0) {
      if (!item.enriched) mailable.push(item); // 规则 3:读取失败 → 降级发信
      continue;
    }
    if (llmBudgetLeftMs() < LLM_MIN_CALL_MS) {
      llmSkipped += 1;
    } else {
      item.llm = await consultLlm(item);
    }
    if (item.llm && isDirectionalStance(item.llm.stance)) {
      mailable.push(item);
      continue;
    }
    if (item.llm == null) {
      // 无定论(失败/预算跳过,区别于"LLM 判了但无方向") → 入补判队列
      state.llmPending[item.qid] = {
        adapter: item.adapter,
        kinds: [...item.kinds],
        title: item.title,
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

  if (mailable.length === 0) {
    // No mailable events: advance the cursor durably first (this progress must
    // not be lost), then best-effort alert on any permanently-skipped gap. The
    // skipped blocks are already gone, so a failed gap alert must not block
    // cursor progress or re-fire forever.
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
    console.log(
      JSON.stringify({
        mode: "chain-watch",
        from,
        to: sweptTo,
        events: logs.length,
        notified: 0,
        suppressed,
        llm_cli_calls: llmCliCallCount(),
        llm_skipped: llmSkipped,
        llm_pending: Object.keys(state.llmPending).length,
        gap,
        sweep_error: sweepError ?? undefined,
      })
    );
    return;
  }

  const llmBacked = mailable.filter((n) => n.llm && isDirectionalStance(n.llm.stance));
  const regexDirectional = mailable.filter((n) => isDirectionalStance(n.stance));
  const subjectBits = [
    regexDirectional.length > 0 ? `${regexDirectional.length} 官方方向` : "",
    llmBacked.length > 0 ? `${llmBacked.length} LLM判读` : "",
    degraded > 0 ? `${degraded} 降级` : "",
  ].filter(Boolean);
  const subject = `[PredEdge 链上] ${mailable.length} 个争议事件${subjectBits.length > 0 ? ` (${subjectBits.join(", ")})` : ""}`;

  const rows = mailable
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
          ? `<div style="margin-top:2px"><b style="color:#2563eb">LLM 判读: ${escapeHtml(n.llm.stance)} (${escapeHtml(n.llm.confidence)}, via=llm)</b>${n.llm.evidence ? `<div style="font-size:12px;color:#666">依据: "${escapeHtml(n.llm.evidence)}"</div>` : ""}${n.llm.reasoning ? `<div style="font-size:12px;color:#888">${escapeHtml(n.llm.reasoning)}</div>` : ""}</div>`
          : `<div style="margin-top:2px;font-size:12px;color:#888">LLM 判读: ${escapeHtml(n.llm.stance)} (${escapeHtml(n.llm.confidence)})</div>`
        : "";
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #333">
          <div style="font-weight:600">${escapeHtml(n.title ?? n.qid)}</div>
          <div style="font-size:12px;color:#888">${kindLabel} · updates=${n.updateCount}${n.refundClause ? " · ⚠️refund条款" : ""}${degradedTag}</div>
          <div style="margin-top:4px">${stanceLine}</div>
          ${llmLine}
          ${n.excerpt ? `<div style="font-size:12px;color:#aaa;margin-top:4px">"${escapeHtml(n.excerpt)}"</div>` : ""}
          <div style="margin-top:4px"><a href="${searchUrl}">在 Polymarket 搜索</a> · qid ${escapeHtml(n.qid.slice(0, 10))}…</div>
        </td></tr>`;
    })
    .join("\n");

  const html = `<div style="font-family:system-ui,sans-serif;max-width:640px">
    <p>链上监听(纯 RPC 模式,无价格数据)在块 ${from}–${sweptTo} 发现方向性争议事件:</p>
    ${gap > 0 ? `<p style="color:#d97706">⚠️ 距上次运行跳过了 ${gap} 个块(停机追赶超出免费 RPC 回看窗口)。</p>` : ""}
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    ${suppressed > 0 ? `<p style="font-size:12px;color:#888">另有 ${suppressed} 个无方向争议事件已按收窄策略静默(仅记日志)。</p>` : ""}
    <p style="font-size:12px;color:#888">直接买入前先在 App 确认盘口价格;LLM 判读(via=llm)是文本解读增强,非官方文本口径(32/32)本身,请核对引用原文。</p>
  </div>`;

  const text = mailable
    .map((n) => {
      const llmBit = n.llm && isDirectionalStance(n.llm.stance) ? ` llm=${n.llm.stance}(${n.llm.confidence})` : "";
      return `${n.title ?? n.qid} | ${[...n.kinds].join("+")} | stance=${n.stance}(${n.confidence})${llmBit}${n.refundClause ? " REFUND" : ""}`;
    })
    .join("\n");

  // At-least-once: send FIRST. If this throws, we fall through to the top-level
  // catch → exit 1 → state is NOT committed → next tick re-scans the same range
  // (cursor unchanged) and retries. A duplicate email on a later success is the
  // accepted trade-off; a permanently-lost dispute alert is not.
  await sendMail({ subject, html, text });
  commitState();
  console.log(
    JSON.stringify({
      mode: "chain-watch",
      from,
      to: sweptTo,
      events: logs.length,
      notified: mailable.length,
      suppressed,
      degraded,
      llm_cli_calls: llmCliCallCount(),
      llm_skipped: llmSkipped,
      llm_backed: llmBacked.length,
      llm_pending: Object.keys(state.llmPending).length,
      gap,
      sweep_error: sweepError ?? undefined,
    })
  );
}

main().catch((err) => {
  console.error(`[chain-watch] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
