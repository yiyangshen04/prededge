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
 * bt5 标记点落地 (2026-07-10):
 *   P1 预告时点预埋 — 官方模板 "if a clarification is to be issued, it will
 *      be at X:00 PM ET" 兑现精度中位 +31s(79/80);解析承诺时点 → 📅 预警
 *      邮件(中位提前 1.55h)→ 承诺窗口内 tick 驻留快轮询(12s 间隔 ethCall
 *      storage 直读)→ 落地即 ⏰ 邮件。3min cron 对 ±31s 结构性失明的解法。
 *   P2 更正裁定 — "previous clarification was made in error" 是全部 6 例真
 *      方向翻转的统一形态;置顶展示+洪水豁免,即使无方向也放行。过双确认
 *      ∧high 闸的保留 🟢+🔄 注解并进 paper 登记,未过闸的 🔄 展示专用。
 *   P3 预告模板负向注解 — green∧预告家族均值 −5.5% 零肥尾,label-only。
 *   E1 dispute 风险标注 — 通知方向与 dispute 时点领先侧同向时标注事件级
 *      翻盘率 6.4-9.3%(扫描口径的 2-3 倍),只标不降档。
 *
 * Run: npx tsx scripts/chain-watch.ts
 * Env: ONCHAIN_RPC_URLS (comma-sep; default publicnode+1rpc), MAIL_* (mailer.ts),
 *      CHAIN_WATCH_STATE (default data/chain-watch-state.json),
 *      CHAIN_WATCH_PREARM=off (P1 总开关)
 */
import { readFileSync } from "fs";
import path from "path";
import { sendMail } from "./mailer";
import { ethCall } from "../lib/polymarket/oracleState";
import { getOfficialUpdates, stanceFromText, detectRefundClause } from "../lib/polymarket/officialContext";
import type { OfficialUpdate } from "../lib/polymarket/officialContext";
import {
  parseScheduledClarification,
  matchesScheduledClarificationTemplate,
  detectCorrection,
} from "../lib/polymarket/clarificationSchedule";
import { classifyStanceWithLlm, llmCliCallCount, type LlmStanceVerdict } from "../lib/polymarket/llmStance";
import { checkExecutability, type ExecCheck } from "../lib/polymarket/execCheck";
import { executeSignal, executionMode, type TradeAttempt } from "../lib/polymarket/tradeExecutor";
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

/** 码点安全截断。String.slice 按 UTF-16 单元切,会切裂 emoji 代理对 —— 链上
 * 标题(敌手可控)的孤代理喂给 encodeURIComponent 直接抛 URIError,而且能把
 * 整个 tick 崩掉(审查确认:敌手可用第 80 位恰跨 emoji 的标题蓄意触发)。 */
function safeSlice(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
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

// ── bt5 标记点落地(P1/P2/P3, 2026-07-10)的常量 ──

/** P1 总开关:预告时点预埋 + 承诺窗口快轮询。 */
const PREARM_ENABLED = (process.env.CHAIN_WATCH_PREARM ?? "").trim().toLowerCase() !== "off";
/** 预埋名单上限。bt5 实测 15 个月 80 个市场,批量裁定日一次可预埋数十个姊妹市场。 */
const PREARM_MAX = 80;
/** 承诺时点前多早进入快轮询。官方偶有提前 1-2 分钟落文本。 */
const PREARM_EARLY_MS = 3 * 60_000;
/** 承诺时点后多久放弃等待。实测兑现中位 +31s、CI 分钟级;15min 足够生死判定,
 * 过期未落地即官方兑现"无澄清"承诺(本身也是信息,见 digest 面包屑)。 */
const PREARM_LATE_MS = 15 * 60_000;
/** 快轮询间隔。ethCall storage 读约 0.1-0.5s/qid,12s 对免费 RPC 无压力。 */
const PREARM_POLL_MS = 12_000;
/** 单轮最多轮询的在窗 qid 数(RPC 负载上限;超出的取承诺时点最近者)。 */
const PREARM_POLL_QIDS_MAX = 12;
/** 快轮询让位时点:run-cron 170s SIGTERM 前留出发信与落盘余量,余下窗口由
 * 下一个 cron tick 接力。 */
const PREARM_LOOP_END_MS = 145_000;
/** 在窗 tick 上常规闸门 LLM 串行判读的让位时点:不设此界,批量姊妹市场日的
 * 闸门会按设计吃满预算(到 ~143s),快轮询恒零轮询 —— P1 在其设计针对的场景
 * (批量定时澄清)静默失效(审查确认)。100s 后闸门不再发起新 LLM 调用
 * (fail-open 照旧,正则方向邮件不受影响),给快轮询保底 ~45s。 */
const PREARM_GATE_LLM_CUTOFF_MS = 100_000;
/** 预埋时点相对 now 的上界。承诺时点只受文本自身约束时,敌手可用近-now 伪
 * 承诺批量挤占名单/让快轮询空转;真实惯例提前量中位 1.55h,48h 已宽裕。 */
const PREARM_MAX_LEAD_NOW_MS = 48 * 3600_000;
/** 单 tick 独立 ⏰ 邮件上限:批量姊妹市场同刻兑现(或敌手批量预埋)时,超出
 * 部分合并为一封批量邮件,不逐市场轰炸(审查确认:⏰ 无洪水闸,可被打成
 * 数十封/tick)。 */
const PREARM_FIRE_SOLO_MAX = 4;

/** run-cron.sh 的 timeout SIGTERM。 */
const TICK_KILL_MS = 170_000;
/** 为 sendMail+commitState 保留的尾部余量。 */
const SEND_MARGIN_MS = 12_000;
/** 剩余预算低于此值不再发起新 LLM 调用。 */
const LLM_MIN_CALL_MS = 15_000;

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
  /** Why it was digested: "flood" (I2 批量裁定限流)、"blue_no_edge" (I5 🔵收窄)
   * 或 "llm_gave_up" (M4 补判放弃兜底,不再静默丢弃)。 */
  reason: string;
  at: number;
}

/** P1: a market whose official text promises a scheduled clarification time
 * ("if a clarification is to be issued, it will be at 1:00 PM ET on ...").
 * The entry is the durable contract — the heads-up mail is best-effort
 * (mailedAt marks success, absent = retry next tick), the in-window fast
 * poll is what actually converts the 1.55h lead into seconds-level reaction. */
interface PreArmEntry {
  adapter: string;
  title: string | null;
  /** 官方承诺的澄清时点(UTC epoch-ms)。 */
  commitAtMs: number;
  /** 模板原文摘录(邮件展示/人工核对)。 */
  quote: string;
  armedAtMs: number;
  /** 预埋时刻的官方 update 数;快轮询以 count 增长为"承诺兑现"判据。 */
  updateCountAtArm: number;
  /** 预埋通知邮件成功送出的时刻;缺失 = 下一 tick 重试。 */
  mailedAt?: number;
  /** 快轮询检出并成功发信后的 "updateCount:stance" 指纹 —— 常规扫描随后看到
   * 同一事件(kinds 可能多出 reset)时凭此去重,避免同一裁定双发。改期覆盖时
   * 必须携带(指纹键与时点无关);其 count > updateCountAtArm 表示"当前预埋代
   * 已兑现",count ≤ updateCountAtArm 表示携带自上一代(新窗口照常轮询)。 */
  firedFp?: string;
  /** 兑现发信时刻 —— fired 条目的保留期锚定它(而非 commitAtMs),停机追赶
   * 迟到的常规扫描事件仍能命中去重。 */
  firedAtMs?: number;
  /** 窗口外经常规扫描看到过新文本(承诺被提前兑现/中途插入其他文本)。 */
  sawUpdate?: boolean;
}

/** P1:该条目在"当前预埋代"(updateCountAtArm 所指的承诺)内是否已兑现发信。
 * firedFp 可能是改期覆盖携带的上一代指纹(count ≤ updateCountAtArm),那一代
 * 的兑现不应阻止新窗口的轮询与预警。 */
function firedCurrentGen(e: PreArmEntry): boolean {
  if (!e.firedFp) return false;
  return Number(e.firedFp.split(":")[0]) > e.updateCountAtArm;
}

interface WatchState {
  lastBlock: number;
  /** qid → fingerprint of the last notified condition (event kinds + update count + stance). */
  notified: Record<string, string>;
  /** qid → LLM re-read queue (see LlmPendingEntry). */
  llmPending: Record<string, LlmPendingEntry>;
  /** qid → V2 storage-poll watchlist (see V2WatchEntry). */
  v2Watch: Record<string, V2WatchEntry>;
  /** qid → P1 预告时点预埋名单(see PreArmEntry). */
  preArm: Record<string, PreArmEntry>;
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
    return { lastBlock: 0, notified: {}, llmPending: {}, v2Watch: {}, preArm: {}, digestQueue: [], mailLog: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      lastBlock: Number(parsed.lastBlock) || 0,
      notified: parsed.notified && typeof parsed.notified === "object" ? parsed.notified : {},
      llmPending:
        parsed.llmPending && typeof parsed.llmPending === "object" ? parsed.llmPending : {},
      v2Watch: parsed.v2Watch && typeof parsed.v2Watch === "object" ? parsed.v2Watch : {},
      preArm: parsed.preArm && typeof parsed.preArm === "object" ? parsed.preArm : {},
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
  /** M3 复判:🟢🔥 候选的第二票与首票极性不一致时存下第二票(降级依据)。
   * undefined = 未复判或复判同向。bt4 实测同 prompt 方向翻转率 5%/次。 */
  llmRevoteMismatch?: LlmStanceVerdict;
  /** M5:同一官方文本(群发到姊妹市场)在本 tick 内出现互相矛盾的
   * eventStatus — 提示 LLM 对同簇事件状态判读不自洽,人工核对时点。 */
  esConflict?: boolean;
  /** P2(bt5/E2):最新官方文本是 "previous clarification was made in error"
   * 型更正 —— 15 个月全部 6 例真方向翻转的统一形态,市场此刻往往仍锚旧裁定
   * 价(错价窗口)。置顶展示并豁免洪水限流;独立通过双确认∧high 闸门的保留
   * 🟢(带 🔄 注解,照常 paper 登记),未过闸的走 🔄 展示专用(见 priorityOf)。 */
  correction?: boolean;
  /** P3(bt5/E3b):update 链含定时澄清预告模板 —— green∧该家族 n=13 均
   * −5.5% 且零肥尾(green∧非预告 +47% 含全部肥尾)。label-only 负向注解。 */
  forecastTemplate?: boolean;
  /** 自动下单结果(EXEC_MODE 控制;undefined = 未尝试)。闸门与 paper 登记
   * 同语义(🟢∧盘口存在),执行器内部另有价格/额度/去重/kill-switch 风控。 */
  trade?: TradeAttempt;
}

/** 从 update 链提取正则立场:优先最新的方向性文本,否则用最新一条的分类。
 * (主扫描 enrich / V2 轮询 / P1 快轮询三处共用的同一语义。) */
function applyStanceFromUpdates(item: Notable): void {
  for (let i = item.updates.length - 1; i >= 0; i -= 1) {
    const classified = stanceFromText(item.updates[i].text);
    if (isDirectionalStance(classified.stance)) {
      item.stance = classified.stance;
      item.confidence = classified.confidence;
      item.excerpt = item.updates[i].text.slice(0, 400);
      return;
    }
  }
  if (item.updates.length > 0) {
    const latest = item.updates[item.updates.length - 1];
    const classified = stanceFromText(latest.text);
    item.stance = classified.stance;
    item.confidence = classified.confidence;
    item.excerpt = latest.text.slice(0, 400);
  }
}

/** P2/P3 文本标记:更正裁定看最后两条(更正通常是最新文本;停机追赶时
 * "更正+后续文本"可能同批到达,只看最新会整体丢标——审查确认);预告模板家族
 * 看全链(与 bt5/E3b 的市场级分类口径一致——裁定落地后预告文本仍在链上)。 */
function annotateTextMarkers(item: Notable): void {
  if (item.updates.length === 0) return;
  if (item.updates.slice(-2).some((u) => detectCorrection(u.text))) item.correction = true;
  if (item.updates.some((u) => matchesScheduledClarificationTemplate(u.text))) {
    item.forecastTemplate = true;
  }
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
  const emptyRange = from > head;
  if (emptyRange) {
    // 陈旧副本/无新块:常规扫描无事可做。但承诺窗口临近时不能提前退出 ——
    // 那会吞掉整个在窗 tick 的快轮询驻留(审查确认:滞后副本恰落在承诺时点
    // 附近时,P1 秒级覆盖被打成 3min 盲洞)。带空扫描范围继续走到尾部。
    const windowSoon =
      PREARM_ENABLED &&
      Object.values(state.preArm).some(
        (e) =>
          !firedCurrentGen(e) &&
          Date.now() + TICK_KILL_MS >= e.commitAtMs - PREARM_EARLY_MS &&
          Date.now() <= e.commitAtMs + PREARM_LATE_MS
      );
    if (!windowSoon) {
      console.log(JSON.stringify({ mode: "chain-watch", head, skipped: "no new blocks" }));
      return;
    }
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
  if (sweptTo < from && !emptyRange) {
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
      applyStanceFromUpdates(item);
      annotateTextMarkers(item);
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
      applyStanceFromUpdates(item);
      annotateTextMarkers(item);
      byQid.set(qid, item);
    } catch {
      // RPC 瞬断 — lastPolledAt 已推进,下轮轮询别的条目,此条稍后重试
    }
  }

  // ── P1:预告澄清时点解析与预埋(bt5/C1)──
  // 模板承诺提前量中位 1.55h、兑现精度中位 +31s(79/80)。对本 tick 全部已
  // enrich 条目扫承诺文本 —— 含将被闸门静默的无方向条目:预告文本本身通常
  // 无方向,恰恰是被静默的那类。解析出未过期承诺 → 预埋;承诺被改期 → 覆盖。
  const maybeArm = (item: Notable): void => {
    if (!PREARM_ENABLED || !item.enriched || item.updates.length === 0) return;
    for (let i = item.updates.length - 1; i >= 0; i -= 1) {
      const u = item.updates[i];
      const parsed = parseScheduledClarification(u.text, u.timestamp * 1000);
      if (!parsed) continue;
      const prev = state.preArm[item.qid];
      // 同一承诺的记账先于过期判断:迟到兑现(承诺已出窗才被扫到)也要落
      // sawUpdate,否则清理逻辑会发"无澄清落地"的假面包屑(审查确认)。
      if (prev && prev.commitAtMs === parsed.commitAtMs) {
        // 快轮询已兑现的那条文本自己经常规扫描复现时(count == firedFp 的
        // count)不抬 updateCountAtArm:抬平会让 firedCurrentGen 变回 false,
        // 已死的窗口复活空转、📅 过时预警可能补发(核验发现的回归)。
        const firedCount = prev.firedFp != null ? Number(prev.firedFp.split(":")[0]) : -1;
        if (item.updateCount > prev.updateCountAtArm && item.updateCount !== firedCount) {
          // 承诺被提前兑现/中途插入其他文本 —— 该文本已走常规闸门,这里只
          // 抬高兑现判据并记录,防止快轮询把同一条再发一遍。
          prev.updateCountAtArm = item.updateCount;
          prev.sawUpdate = true;
        }
        if (prev.title == null && item.title != null) prev.title = item.title;
        return;
      }
      // 最新一条承诺为准(改期即覆盖);已出窗的旧承诺不再预埋。
      if (parsed.commitAtMs + PREARM_LATE_MS <= Date.now()) return;
      // 敌手防御(审查确认):承诺时点只受文本自身约束时,近-now 伪承诺可批量
      // 挤占名单并让快轮询空转。上界锚定 now;残余的蓄意挤占最坏使 P1 退化回
      // 3min cron 基线(= 当前生产行为),不影响主管道任何告警。
      if (parsed.commitAtMs > Date.now() + PREARM_MAX_LEAD_NOW_MS) return;
      state.preArm[item.qid] = {
        adapter: item.adapter,
        title: item.title,
        commitAtMs: parsed.commitAtMs,
        quote: parsed.quote,
        armedAtMs: Date.now(),
        updateCountAtArm: item.updateCount,
        // 承诺文本之后已有更新文本(停机追赶时承诺+裁定同批到达):裁定已走
        // 常规闸门,这里只为窗口内可能的再次文本守望;过期不误报"无澄清"。
        ...(i < item.updates.length - 1 || prev?.sawUpdate ? { sawUpdate: true } : {}),
        // 改期覆盖必须携带去重指纹(键=updateCount:stance,与时点无关):否则
        // 已 ⏰ 发过的裁定在常规扫描复见(kinds 多出 reset)时双发(审查 major)。
        ...(prev?.firedFp ? { firedFp: prev.firedFp } : {}),
        ...(prev?.firedAtMs ? { firedAtMs: prev.firedAtMs } : {}),
        // 📅 邮件史 6h 冷却内携带:防敌手以每 3min 改期 tx 维持无限重发(审查
        // major);真实改期(bt5 未观测到)的代价是新时点预警可能被冷却吞掉,
        // 快轮询窗口本身照常重定位。
        ...(prev?.mailedAt && Date.now() - prev.mailedAt < 6 * 3600_000 ? { mailedAt: prev.mailedAt } : {}),
      };
      return;
    }
  };
  if (PREARM_ENABLED) {
    for (const item of byQid.values()) maybeArm(item);
  }
  // 过期清理:出窗未兑现 = 官方兑现了"无澄清"承诺,进 digest 留痕(不即时打扰,
  // 但这是"官方不会再说话"的确定性信息,人工据此可撤销观察)。兑现过的静默删。
  // 面包屑按 tick 聚合成单条:批量预告日一次可过期数十条,逐条入队会触发
  // digestQueue 100 条截断、挤掉真正的方向性信号(审查 major)。
  {
    const expiredUnanswered: Array<{ qid: string; title: string | null }> = [];
    for (const [qid, e] of Object.entries(state.preArm)) {
      // 兑现过的条目保留期锚定 fire 时刻(+30min):停机追赶迟到的常规扫描事件
      // 仍需命中 firedFp 去重,防边窗兑现被双发。
      const retainUntil = Math.max(
        e.commitAtMs + PREARM_LATE_MS,
        e.firedAtMs != null ? e.firedAtMs + 30 * 60_000 : 0
      );
      if (retainUntil > Date.now()) continue;
      if (!e.firedFp && !e.sawUpdate) expiredUnanswered.push({ qid, title: e.title });
      delete state.preArm[qid];
    }
    if (expiredUnanswered.length > 0) {
      const titles = expiredUnanswered
        .slice(0, 3)
        .map((x) => x.title ?? x.qid.slice(0, 10))
        .join(" / ");
      state.digestQueue.push({
        qid: expiredUnanswered[0].qid,
        title: `${titles}${expiredUnanswered.length > 3 ? ` 等${expiredUnanswered.length}个` : ""}`,
        label: `📅 预告时点已过,无澄清落地 ×${expiredUnanswered.length}(官方承诺兑现:不再有澄清)`,
        stance: "none",
        llmStance: null,
        bestAsk: null,
        askUsd: null,
        marketUrl: null,
        reason: "prearm_expired",
        at: Date.now(),
      });
    }
  }
  // 名单封顶:批量预告日一次可涌入数十个姊妹市场,超限时保承诺时点最近者。
  {
    const entries = Object.entries(state.preArm);
    if (entries.length > PREARM_MAX) {
      entries.sort((a, b) => a[1].commitAtMs - b[1].commitAtMs);
      for (const [qid] of entries.slice(PREARM_MAX)) delete state.preArm[qid];
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
    // P1 快轮询去重:承诺窗口内已对该 update 状态(count+stance)发过 ⏰ 邮件;
    // 常规扫描随后看到的同一事件 kinds 可能多出 reset(模板常伴 orderbook
    // clear),指纹因此不同 —— 单看 kinds 差异不值得对同一裁定再发一封。
    // 仅当本 tick 确实带 context(同一文本事件,reset 只是伴生)才吞;纯 reset
    // (对新裁定的真实 dispute,updates 数未变)必须放行(审查 major:宁重发,
    // 不吞新争议)。
    if (
      item.kinds.has("context") &&
      state.preArm[item.qid]?.firedFp === `${item.updateCount}:${item.stance}`
    ) {
      pendingFingerprints.set(item.qid, fingerprint); // 指纹照常推进
      return false;
    }
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
  // 硬预算:SIGTERM 前的真实剩余。快轮询的决策与单次调用的超时钳制用它。
  const wallBudgetLeftMs = () => TICK_KILL_MS - SEND_MARGIN_MS - elapsed();
  // 软预算:常规闸门视角的剩余。承诺窗口临近/进行中的 tick 上,闸门(含补判
  // 队列/盘口注解/复判)在 PREARM_GATE_LLM_CUTOFF_MS 后不再发起新调用,为 P1
  // 快轮询保底 ~45s(审查确认:无此界则批量姊妹市场日闸门按设计吃满预算,
  // 快轮询恒零轮询,P1 在其设计针对的场景静默失效)。fail-open 语义照旧:
  // 被让位跳过的判读走 llmPending 补判,正则方向邮件不受影响。
  const prearmWindowSoon = () =>
    PREARM_ENABLED &&
    Object.values(state.preArm).some(
      (e) =>
        !firedCurrentGen(e) &&
        Date.now() + TICK_KILL_MS >= e.commitAtMs - PREARM_EARLY_MS &&
        Date.now() <= e.commitAtMs + PREARM_LATE_MS
    );
  const llmBudgetLeftMs = () =>
    prearmWindowSoon()
      ? Math.min(PREARM_GATE_LLM_CUTOFF_MS - elapsed(), wallBudgetLeftMs())
      : wallBudgetLeftMs();
  // 单次调用的超时被钳到剩余预算内:一个 149s 才开始的 60s 调用会越过 170s
  // SIGTERM,把整个 tick(连同待发的正则方向邮件和 commitState)一起杀掉。
  const consultLlm = (
    item: {
      qid: string;
      title: string | null;
      description: string | null;
      updates: OfficialUpdate[];
      stance: string;
      confidence: string;
      updateCount: number;
    },
    // M3 复判用:不同 suffix = 不同缓存键 → 强制真实第二票而非缓存回放
    cacheKeySuffix = ""
  ): Promise<LlmStanceVerdict | null> =>
    classifyStanceWithLlm({
      title: item.title,
      description: item.description,
      updates: item.updates,
      regexStance: { stance: item.stance, confidence: item.confidence },
      cacheKey: `${item.qid}:${item.updateCount}${cacheKeySuffix}`,
      timeoutMs: Math.min(60_000, wallBudgetLeftMs()),
    });

  const mailable: Notable[] = [];
  let llmSkipped = 0;

  // A. 上轮遗留的 LLM 补判队列:本轮真实进入闸门的 qid 交回闸门处理(若又
  //    失败会重新入队);其余在预算内逐个补判,有定论(无论方向与否)即出队。
  //    交接判据必须是 notable 而非 byQid(审查打回后修正):快轮询兑现过的
  //    事件在常规扫描复现时恰好被指纹/firedFp 去重吞掉 —— byQid 有、notable
  //    无,按旧判据删除即把 16 次/48h 的补判契约结构性切断(M4 回归形态)。
  const notableQids = new Set(notable.map((n) => n.qid));
  for (const [qid, p] of Object.entries(state.llmPending)) {
    if (notableQids.has(qid)) {
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
      annotateTextMarkers(revived);
      maybeArm(revived);
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
      // M4:放弃 ≠ 静默丢弃。bt4 案例 14c9:被 null 吞掉的恰是"事后官方明写
      // qualifies for Yes"的最高置信信号。进汇总队列(非即时,不重开噪音闸)。
      state.digestQueue.push({
        qid,
        title: p.title,
        label: `⚪ LLM 判读失败(${p.attempts >= 16 ? `${p.attempts} 次尝试` : "48h"}后放弃),正则亦无方向 — 建议人工瞄一眼`,
        stance: "none",
        llmStance: null,
        bestAsk: null,
        askUsd: null,
        marketUrl: null,
        reason: "llm_gave_up",
        at: Date.now(),
      });
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
    // P2:更正裁定即使双双无方向也放行 —— "撤回旧裁定"这一事件本身就是错价
    // 窗口信号(bt5/E2:全部真翻转都是此形态),静默等于丢掉最肥的时刻。
    if (regexDirectional || llmDirectional || item.correction) {
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
  // 值得打开。分级依据 bt4 实测(2026-07-09,v4 全量重放 + 四实验臂):
  //   🟢 只授"双确认∧LLM conf=high"——该格是唯一跨 prompt 稳健结构
  //   (v3/v4/A2/A4 四臂交集 17 笔 17/17 全胜,累计 +524%);medium 置信区
  //   含历史全部 -100% 级灾难,一律降 🟠 展示(M1,邮件照发)。
  //   🟢🔥 肥尾候选 > 🟢 双确认 > 🟠 官方方向(LLM拒判/中置信/无定论/红旗)
  // > 🔵 LLM 单独判读 > ⚪ 降级。
  const polarity = (stance: string): string => {
    if (/YES$/i.test(stance)) return "+";
    if (/NO$/i.test(stance)) return "-";
    return stance; // resolve_to_* 等:要求字面一致
  };
  // I4 规则层边界闸门(eventStatus=pending ∧ leans_* → 降档)。M6 注:bt4 实测
  // 该闸门 15 个月仅触发 1 次且拦下的是 +1.0% 赢单——几乎不承担防损职能
  // (实测全部深亏在 es=decided 侧,由 M1/M2 防守);保留仅作标注语义。
  // 注意:M1 上线后 off 挡只能 A/B 到 high 置信的 pending∧leans 形态(medium
  // 已被 M1 无条件降档,不再回到 I4 前的旧行为)。
  const boundaryGuardOn = (process.env.LLM_BOUNDARY_GUARD ?? "").trim().toLowerCase() !== "off";
  const boundaryPending = (n: Notable): boolean =>
    boundaryGuardOn &&
    n.llm?.eventStatus === "pending" &&
    (/^leans_/i.test(n.llm.stance) || /^leans_/i.test(n.stance));
  const basePriorityOf = (n: Notable): { rank: number; label: string } => {
    const llmDir = n.llm != null && isDirectionalStance(n.llm.stance) && n.llm.confidence !== "low";
    // P3(bt5/E3b):预告模板家族的绿档负向注解(label-only,不降档)。
    const forecastBit = n.forecastTemplate ? " ⚠预告模板家族(bt5:绿档均值−5.5%·零肥尾)" : "";
    if (isDirectionalStance(n.stance)) {
      if (llmDir && polarity(n.llm!.stance) === polarity(n.stance)) {
        if (boundaryPending(n))
          return { rank: 1, label: `🟠 官方方向 ${n.stance}·${n.confidence} (⚠️边界澄清·事件未决)` };
        // M1:🟢 只授 conf=high。bt4 实测 medium 区 = 历史全部 -100% 所在,
        // 且各臂全档收益差异均来自 medium 区归属(高置信档对 prompt 不敏感)。
        if (n.llm!.confidence !== "high")
          return { rank: 1, label: `🟠 官方方向 ${n.stance}·${n.confidence} (双确认·中置信⚠历史灾难区)` };
        const ask = n.exec?.bestAsk ?? null;
        // M2 H2 红旗:极端逆共识(方向价 <0.15 = 判读逆着 85%+ 市场共识)且
        // LLM 非决断句式(leans_*) → 不给 🟢。bt4 实测该形态 4/4 归零,而真肥尾
        // (Norway@0.164/Khamenei@0.179)入场价均 ≥0.15 且判读为决断级。
        if (ask != null && ask < 0.15 && /^leans_/i.test(n.llm!.stance))
          return { rank: 1, label: `🟠 官方方向 ${n.stance}·${n.confidence} (🚩极端逆共识·历史此形态4/4归零)` };
        // M3:🟢🔥 复判分歧 → 降档(同 prompt 方向翻转率实测 5%/次)。二票反向
        // 与二票失方向分开表述——标签必须如实,人工分诊靠它。
        if (n.llmRevoteMismatch)
          return {
            rank: 1,
            label: `🟠 官方方向 ${n.stance}·${n.confidence} (${
              isDirectionalStance(n.llmRevoteMismatch.stance) ? "复判反向⚠" : "复判失方向⚠"
            }:二票 ${n.llmRevoteMismatch.stance})`,
          };
        // I3 🟢 内部再分级:入场价离 1 越远(市场重仓反向)越像肥尾;尾价 ≥0.97
        // 只是薄利 carry。无盘口数据时退化为"是否处于争议(reset)"判断。
        if ((ask != null && ask <= 0.9) || (ask == null && n.kinds.has("reset")))
          return { rank: 0, label: `🟢🔥 肥尾候选 ${n.stance}·${n.confidence}${forecastBit}` };
        if (ask != null && ask >= 0.97)
          return { rank: 0, label: `🟢 双确认 ${n.stance}·${n.confidence} (尾价carry)${forecastBit}` };
        return { rank: 0, label: `🟢 双确认 ${n.stance}·${n.confidence}${forecastBit}` };
      }
      if (n.llm && !isDirectionalStance(n.llm.stance))
        return { rank: 1, label: `🟠 官方方向 ${n.stance}·${n.confidence} (LLM拒判⚠)` };
      return { rank: 1, label: `🟠 官方方向 ${n.stance}·${n.confidence}` };
    }
    if (llmDir) return { rank: 2, label: `🔵 LLM判读 ${n.llm!.stance}·${n.llm!.confidence}` };
    if (!n.enriched) return { rank: 3, label: `⚪ 降级(文本读取失败)` };
    return { rank: 4, label: `⚪ ${n.stance}` };
  };
  // P2(bt5/E2):更正裁定的分层语义(设计复盘后修正,2026-07-10)。
  // 数据:6 例真翻转中 4 个已结算全部按更正方向落地,且 v3 对更正文本全判
  // 方向·high —— 但它们在 286 行真实成交经济样本里只有 1 行(入场 0.99,窗口
  // 内 0-1 笔成交),历史绿档战绩(20/20)几乎没有更正类贡献,且 6 例=同一晚
  // 同一事故簇(统计上是 1 个事件)。因此:
  //   · 更正 ∧ 独立通过双确认∧high 闸门 → 保留 🟢 标签(闸门定义从未排除
  //     更正,这是对验证过配置的保真)+ 追加 🔄 注解 + 照常进 paper 登记
  //     (前瞻账本恰恰需要这类样本来裁决更正类是否配得上完整绿档);
  //     错价窗口下 ask≤0.9 会自然落 🟢🔥 → M3 复判照常加持。
  //   · 更正但未过闸(无方向/中置信/红旗/复判分歧) → 🔄 置顶展示专用,
  //     不冒充 🟢:官方在本市场已自证会出错,二次更正先验不同于 32/32 口径。
  const priorityOf = (n: Notable): { rank: number; label: string } => {
    const base = basePriorityOf(n);
    if (!n.correction) return base;
    if (base.rank === 0 && base.label.startsWith("🟢")) {
      return { rank: 0, label: `${base.label} ·🔄更正裁定` };
    }
    const llmDir = n.llm != null && isDirectionalStance(n.llm.stance) && n.llm.confidence !== "low";
    const st = isDirectionalStance(n.stance)
      ? `${n.stance}·${n.confidence}`
      : llmDir
        ? `${n.llm!.stance}·${n.llm!.confidence}(via=llm)`
        : "方向待人工判读⚠";
    return { rank: 0, label: `🔄 官方更正裁定(issued-in-error) ${st}` };
  };
  const isFatTail = (n: Notable): boolean => priorityOf(n).label.includes("肥尾候选");
  // 肥尾"形态"(双确认∧深价位/争议中,不含 M1/M2/M3 的降档条件):洪水豁免用它
  // 而非 isFatTail——降档承诺是 label-only,被降档的肥尾形态若因此从即时改走
  // 6h 汇总,恰恰在批量裁定日延误了灾难形/机会形并存的关键告警(审查修正)。
  // 置信 low 不算(降档前的旧口径也从不给 low 豁免)。
  const isFatTailShape = (n: Notable): boolean => {
    if (!isDirectionalStance(n.stance)) return false;
    if (!n.llm || !isDirectionalStance(n.llm.stance) || n.llm.confidence === "low") return false;
    if (polarity(n.llm.stance) !== polarity(n.stance)) return false;
    const ask = n.exec?.bestAsk ?? null;
    return (ask != null && ask <= 0.9) || (ask == null && n.kinds.has("reset"));
  };

  // ── bt5/E1:dispute 时点领先侧翻盘风险标注 ──
  // 事件时点买领先侧的事件级翻盘率:ask≥0.95 → 6.4%,0.90–0.95 → 9.3% ——
  // 是 30s 扫描口径(≈3%,repricing 后幸存者)的 2-3 倍。通知方向与领先侧一致
  // (= 按方向买入价 ≥0.90)且本 tick 带 reset 事件时如实标注;只标不降档。
  const disputeRiskNote = (n: Notable): string | null => {
    if (!n.kinds.has("reset")) return null;
    const ask = n.exec?.bestAsk ?? null;
    if (ask == null || ask < 0.9) return null;
    const eff = isDirectionalStance(n.stance)
      ? n.stance
      : n.llm && isDirectionalStance(n.llm.stance)
        ? n.llm.stance
        : null;
    if (!eff) return null;
    return `⚠ 事件级翻盘风险 ${ask >= 0.95 ? "6.4%" : "9.3%"}(dispute 时点领先侧同向,bt5/E1)`;
  };

  // ── 自动下单结果的呈现(主路径与 P1 快路径共用)──
  const tradeLineHtml = (n: Notable): string => {
    const t = n.trade;
    if (!t) return "";
    if (t.status === "filled" || t.status === "partial")
      return `<div style="margin-top:2px;font-size:13px"><b style="color:#16a34a">🤖 已自动买入 ${escapeHtml(n.exec?.outcome ?? "")} $${t.filledUsd?.toFixed(2)}${t.status === "partial" ? `(部分,请求 $${t.requestedUsd}` + ")" : ""} @ 均价 ${t.avgPrice?.toFixed(3)}</b><span style="font-size:12px;color:#888"> · orderId ${escapeHtml((t.orderId ?? "?").slice(0, 12))}… · ${((t.latencyMs ?? 0) / 1000).toFixed(1)}s</span></div>`;
    if (t.status === "none")
      return `<div style="margin-top:2px;font-size:13px;color:#d97706">🤖 FAK 提交成功但未成交(限价 ${t.limitPrice} 内无对手盘),已自动撤单</div>`;
    if (t.status === "dry")
      return `<div style="margin-top:2px;font-size:13px;color:#2563eb">🤖[演练] 将买入 ${escapeHtml(n.exec?.outcome ?? "")} $${t.requestedUsd} @≤${t.limitPrice}(EXEC_MODE=dry,未提交)</div>`;
    if (t.status === "error")
      return `<div style="margin-top:2px;font-size:13px"><b style="color:#dc2626">🤖 自动下单失败: ${escapeHtml(t.reason ?? "未知错误")}</b></div>`;
    return `<div style="margin-top:2px;font-size:12px;color:#888">🤖 未下单: ${escapeHtml(t.reason ?? "")}</div>`;
  };
  const tradeSubjectBit = (n: Notable): string => {
    const t = n.trade;
    if (!t) return "";
    if (t.status === "filled") return ` 🤖已买$${t.filledUsd?.toFixed(0)}`;
    if (t.status === "partial") return ` 🤖部分$${t.filledUsd?.toFixed(0)}`;
    if (t.status === "error") return " 🤖下单失败⚠";
    if (t.status === "none") return " 🤖未成交";
    if (t.status === "dry") return " 🤖dry";
    return "";
  };
  const tradeTextBit = (n: Notable): string => {
    const t = n.trade;
    if (!t) return "";
    if (t.status === "filled" || t.status === "partial")
      return ` TRADE:${t.status} $${t.filledUsd} @${t.avgPrice}`;
    return ` TRADE:${t.status}${t.reason ? `(${t.reason.slice(0, 60)})` : ""}`;
  };

  // ── M3:🟢🔥 复判(独立第二票)──
  // bt4/A5 实测:同 prompt 两次判读方向层翻转率 5%;三票多数杀噪声型误判
  // (Mutilation)但救不了系统性误读。🟢🔥 月频 ~1.4 笔,二票成本可忽略。
  // 降档条件(审查修正):二票方向性且极性相反(复判反向),或二票不再方向性
  // (复判失方向——模型在新采样下主动收回方向,这是信息)。二票同极性一律保持,
  // 不看二票置信度:弱同意仍是同意,否则"弱同意"会比"复判失败(null,保持原判
  // 的 fail-open)"更糟,语义倒挂。
  for (const n of mailable) {
    if (llmBudgetLeftMs() < LLM_MIN_CALL_MS) break;
    if (!n.llm || !isFatTail(n)) continue;
    const second = await consultLlm(n, ":v2");
    if (second == null) continue;
    const agrees =
      isDirectionalStance(second.stance) && polarity(second.stance) === polarity(n.llm.stance);
    if (!agrees) n.llmRevoteMismatch = second;
  }

  // ── M5:同簇 eventStatus 一致性 ──
  // 同一官方文本群发到姊妹市场(bt4 案例 61a1:同文本一个市场判 decided、
  // 另一个判 pending)。方向可以因市场问题不同而不同,但"事件是否已决"不该
  // 自相矛盾——检测到即标注,供人工核对时点(不自动改判)。
  {
    const esByText = new Map<string, Set<string>>();
    for (const n of mailable) {
      const es = n.llm?.eventStatus;
      if (!es || n.updates.length === 0) continue;
      const key = n.updates[n.updates.length - 1].text;
      if (!esByText.has(key)) esByText.set(key, new Set());
      esByText.get(key)!.add(es);
    }
    for (const n of mailable) {
      if (!n.llm?.eventStatus || n.updates.length === 0) continue;
      const set = esByText.get(n.updates[n.updates.length - 1].text);
      // 只有 decided 与 pending 同时出现才是真矛盾;unclear 与谁共存都不算
      // (unclear=文本没说,不构成对立判断,审查修正)。
      if (set && set.has("decided") && set.has("pending")) n.esConflict = true;
    }
  }

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
    // I2:批量裁定洪水(2026-06 单月 690 信号/单日峰 320)中,只有肥尾候选、
    // 更正裁定(P2:全部真翻转形态,且事故簇之夜恰恰触发洪水——2025-11-17 实例)
    // 与降级告警(enriched=false,安全兜底语义不能延迟)保持即时,其余进汇总。
    if (floodActive && pr.rank <= 2 && !isFatTail(n) && !isFatTailShape(n) && !n.correction && n.enriched) {
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
    // 截断分层(审查 major):信息性面包屑(prearm_expired)先让位,方向性事件
    // (flood/blue_no_edge/llm_gave_up)最后才丢 —— 否则批量预告过期会把真正
    // 的方向性信号从队列里静默挤掉(其指纹已提交,丢即永久)。
    let toDrop = state.digestQueue.length - 100;
    state.digestQueue = state.digestQueue.filter((d) => {
      if (toDrop > 0 && d.reason === "prearm_expired") {
        toDrop -= 1;
        return false;
      }
      return true;
    });
    if (toDrop > 0) state.digestQueue.splice(0, toDrop);
  }

  // ── I6: 🟢 自动登记 paper_trades(前瞻虚拟持仓,再也不用事后重建回测)──
  // localDb 惰性加载:chain-watch 的承诺是"无 sqlite 也能跑",登记失败只记日志。
  // 登记门槛 = 🟢 标签(而非 rank 0):P2 更正裁定同为 rank 0 但未经四臂验证,
  // 只通知不进前瞻登记。P1 快轮询检出的 🟢 走同一 helper。
  let paperRegistered = 0;
  const maybeRegisterPaperTrade = (n: Notable): void => {
    if ((process.env.PAPER_TRADES_AUTO ?? "").trim().toLowerCase() === "off") return;
    const pr = priorityOf(n);
    if (pr.rank !== 0 || !pr.label.startsWith("🟢")) return;
    const e = n.exec;
    if (!e || e.closed || !e.fill100) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const db = require("../lib/localDb") as typeof import("../lib/localDb");
      if (db.listOpenPaperTrades().some((t) => t.tokenId === e.tokenId)) return;
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
  };
  for (const n of mailable) maybeRegisterPaperTrade(n);

  // ── 自动下单(2026-07-10):与 paper 登记同一闸门(🟢 标签 ∧ 盘口存在),
  // 风控(EXEC_MODE 三态/kill-switch/单笔/日/总额度/价格带/滑点/去重 ledger)
  // 全部在 executeSignal 内部。fail-open:执行器绝不 throw,任何失败都只是
  // 邮件里多一行结果注解,绝不阻塞告警。P2 更正裁定过闸的 🟢(带🔄注解)照常
  // 执行 —— 与 paper 登记口径保持一致;🔄 展示专用(未过闸)不执行。
  const maybeExecuteTrade = async (n: Notable): Promise<void> => {
    if (executionMode() === "off" || n.trade !== undefined) return;
    const pr = priorityOf(n);
    if (pr.rank !== 0 || !pr.label.startsWith("🟢")) return;
    const e = n.exec;
    if (!e || e.closed || !e.tokenId) return;
    try {
      n.trade = await executeSignal({
        qid: n.qid,
        tokenId: e.tokenId,
        conditionId: e.conditionId,
        outcome: e.outcome,
        question: e.question,
        marketUrl: e.marketUrl,
        label: pr.label,
        stance: n.stance,
        llmStance: n.llm?.stance ?? null,
        llmConfidence: n.llm?.confidence ?? null,
        bestAskAtSignal: e.bestAsk,
        negRisk: e.negRisk,
        forecastTemplate: n.forecastTemplate === true,
        correction: n.correction === true,
        budgetMs: wallBudgetLeftMs(),
      });
      console.log(
        JSON.stringify({
          mode: "chain-watch-trade",
          qid: n.qid.slice(0, 12),
          token: e.tokenId.slice(0, 12),
          status: n.trade.status,
          reason: n.trade.reason,
          usd: n.trade.filledUsd ?? n.trade.requestedUsd,
          avgPrice: n.trade.avgPrice,
          latencyMs: n.trade.latencyMs,
        })
      );
    } catch (err) {
      // executeSignal 自身兜底不 throw;这里是双保险
      console.warn(
        `[chain-watch] 自动下单异常(${n.qid.slice(0, 10)}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
  for (const n of mailable) await maybeExecuteTrade(n);

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

  // ── P1:预埋通知邮件 ──
  // 1.55h 中位预警是人工模式此前结构性吃不到肥尾的唯一解法:提前到场。
  // 邮件 best-effort(mailedAt 标记成功,失败下轮重试);预埋状态本身随
  // commitState 已持久化,快轮询不依赖邮件是否送达。
  const flushPreArmMail = async (): Promise<void> => {
    if (!PREARM_ENABLED) return;
    // 只预警未来时点:已到/已过的承诺没有"提前到场"价值(快轮询 ⏰ 会覆盖),
    // 且这恰好封掉"近过去伪承诺 → 过期删条目洗掉 6h 冷却 → 重发"的骚扰向量
    // (核验发现的残余绕道)。
    const pending = Object.entries(state.preArm)
      .filter(([, e]) => !e.mailedAt && !firedCurrentGen(e) && e.commitAtMs > Date.now())
      .sort((a, b) => a[1].commitAtMs - b[1].commitAtMs);
    if (pending.length === 0) return;
    try {
      // rows 构造也在 try 内:链上文本喂进任何编码/格式化都可能抛(审查确认过
      // 代理对切裂案例),这里失败只能降级重试,不能把整个 tick 崩掉。
      const fmtRel = (ms: number): string => {
        const mins = Math.round((ms - Date.now()) / 60_000);
        if (mins <= 0) return "已到时点,本 tick 即进入快轮询"; // 边窗预埋不渲染负时长
        return mins >= 90 ? `约 ${(mins / 60).toFixed(1)}h 后` : `约 ${mins}min 后`;
      };
      const rows = pending
        .map(([qid, e]) => {
          const searchUrl = e.title
            ? `https://polymarket.com/search?q=${encodeURIComponent(safeSlice(e.title, 80))}`
            : "https://polymarket.com";
          return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px">
          <b>${escapeHtml(e.title ?? qid)}</b><br>
          <span style="color:#2563eb">承诺时点 ${new Date(e.commitAtMs).toISOString().slice(0, 16).replace("T", " ")}Z(${fmtRel(e.commitAtMs)})</span><br>
          <span style="font-size:12px;color:#888">"${escapeHtml(e.quote)}"</span><br>
          <a href="${searchUrl}">在 Polymarket 搜索</a> · qid ${escapeHtml(qid.slice(0, 10))}…
        </td></tr>`;
        })
        .join("\n");
      await sendMail({
        subject: `[PredEdge链上] 📅 官方预告澄清时点 ×${pending.length} | 最近 ${new Date(pending[0][1].commitAtMs).toISOString().slice(5, 16).replace("T", " ")}Z`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:640px">
          <p>官方文本承诺了定时澄清(bt5/C1:该模板 79/80 在承诺时点 ±1 分钟内兑现,提前量中位 1.55h):</p>
          <table style="width:100%;border-collapse:collapse">${rows}</table>
          <p style="font-size:12px;color:#888">系统将在各承诺时点 −${PREARM_EARLY_MS / 60_000}min/+${PREARM_LATE_MS / 60_000}min 窗口内以 ${PREARM_POLL_MS / 1000}s 间隔快轮询,裁定落地即发 ⏰ 邮件;时点过后无文本 = 官方兑现"无澄清"(digest 留痕)。注意:预告模板家族属绿档负收益家族(bt5/E3b:均值 −5.5%·零肥尾),届时信号请按注解审慎对待。</p>
        </div>`,
        text: pending
          .map(([qid, e]) => `${e.title ?? qid} | 承诺时点 ${new Date(e.commitAtMs).toISOString()} | "${e.quote.slice(0, 120)}"`)
          .join("\n"),
      });
      const now = Date.now();
      for (const [, e] of pending) e.mailedAt = now;
      saveState(state);
    } catch (err) {
      console.error(
        `[chain-watch] P1 预埋通知发送失败(下轮重试): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  // ── P1:承诺时点快轮询 ──
  // bt5/C1 实测兑现精度中位 +31s,3min cron 结构性吃不到;e6 全窗口重抓证明
  // 收益断崖在 2-5 分钟(秒级入场较 2min 每笔 +5.75~12.75pp)。窗口内本 tick
  // 不退出:以 PREARM_POLL_MS 间隔直读各预埋 qid 的官方 updates(ethCall
  // storage 读,V1/V2 一律有效,绕开 V2 不发事件的盲区),新文本落地即完整判读
  // (正则+LLM+盘口+复判)。前 PREARM_FIRE_SOLO_MAX 个兑现独立发信,其余合并
  // 单封批量邮件(⏰ 无洪水闸,批量姊妹市场日不逐市场轰炸——审查 major)。
  // PREARM_LOOP_END_MS 让位给下一 tick 接力。
  const runPreArmFastLoop = async (): Promise<void> => {
    if (!PREARM_ENABLED) return;
    // 批量待发:已检出并判读、等 loop 末合并成单封邮件的兑现条目。firedFp 在
    // 邮件成功后才置位(at-least-once);置位前用本地集合防同 tick 重复检出。
    const batchPending = new Map<string, { e: PreArmEntry; item: Notable; latencyS: number }>();
    const inWindow = () =>
      Object.entries(state.preArm)
        .filter(
          ([qid, e]) =>
            !firedCurrentGen(e) &&
            !batchPending.has(qid) &&
            Date.now() >= e.commitAtMs - PREARM_EARLY_MS &&
            Date.now() <= e.commitAtMs + PREARM_LATE_MS
        )
        .sort((a, b) => a[1].commitAtMs - b[1].commitAtMs)
        .slice(0, PREARM_POLL_QIDS_MAX);
    if (inWindow().length === 0) return;
    console.log(`[chain-watch] P1 快轮询进入承诺窗口(${inWindow().length} 个预埋市场)`);
    let polls = 0;
    let fired = 0;
    // M5 同簇 es 一致性的快路径增量版:同 tick 先后兑现的姊妹市场共享同一
    // 官方文本时,decided/pending 矛盾照常标注(审查 major:原先完全绕过 M5)。
    const esSeenFast = new Map<string, Set<string>>();
    const markFired = (qid: string, e: PreArmEntry, item: Notable, rank: number): void => {
      e.firedFp = `${item.updateCount}:${item.stance}`;
      e.firedAtMs = Date.now();
      if (rank <= 2) state.mailLog.push(Date.now());
      delete state.notified[qid];
      state.notified[qid] = `context:${item.updateCount}:${item.stance}`;
      maybeRegisterPaperTrade(item);
    };
    while (elapsed() < PREARM_LOOP_END_MS) {
      const targets = inWindow();
      if (targets.length === 0) break;
      for (const [qid, e] of targets) {
        if (elapsed() >= PREARM_LOOP_END_MS) break;
        try {
          const { updates } = await getOfficialUpdates({ resolvedBy: e.adapter, questionID: qid });
          polls += 1;
          if (updates.length <= e.updateCountAtArm) continue;
          // 承诺兑现:新官方文本落地。与主闸门同语义的完整判读。
          const meta = await fetchQuestionMeta(e.adapter, qid);
          const item: Notable = {
            qid,
            adapter: e.adapter,
            kinds: new Set(["context"]),
            title: e.title ?? meta.title,
            description: meta.description,
            stance: "none",
            confidence: "none",
            refundClause: detectRefundClause(updates.map((u) => u.text)),
            excerpt: null,
            updateCount: updates.length,
            updates,
            enriched: true,
          };
          applyStanceFromUpdates(item);
          annotateTextMarkers(item);
          if (wallBudgetLeftMs() >= LLM_MIN_CALL_MS) item.llm = await consultLlm(item);
          else llmSkipped += 1;
          // M4 语义(审查 major):判读无定论(CLI 失败/预算跳过)且正则无方向时
          // 必须入 llmPending 补判队列 —— firedFp 会拦住常规扫描对同一事件的
          // 复核,不入队 = 判读升级通道被结构性切断(bt4 null 吞单的回归形态)。
          // correction 不入队(与主闸门语义一致:更正无论方向都已放行发信);
          // 判读成功则清掉早前失败轮次写入的旧条目,防 A 段重复升级发信。
          if (item.llm != null) {
            delete state.llmPending[qid];
          } else if (!isDirectionalStance(item.stance) && !item.correction) {
            state.llmPending[qid] = {
              adapter: item.adapter,
              kinds: [...item.kinds],
              title: item.title,
              description: item.description,
              attempts: 0,
              firstSeenAt: Date.now(),
            };
          }
          // 盘口先于复判(审查 major:肥尾判定依赖 exec.bestAsk,原顺序下恒
          // false,M3 复判在快路径曾是死代码)。
          const effStance = isDirectionalStance(item.stance)
            ? item.stance
            : item.llm && isDirectionalStance(item.llm.stance)
              ? item.llm.stance
              : null;
          if (effStance && wallBudgetLeftMs() > 10_000) {
            item.exec = await checkExecutability({ adapter: item.adapter, qid, stance: effStance });
          }
          // M3 复判:🟢 且(深价位或盘口未知)= 肥尾候选形态,关键决策必须二票。
          if (item.llm && wallBudgetLeftMs() >= LLM_MIN_CALL_MS) {
            const prePr = priorityOf(item);
            if (
              prePr.label.startsWith("🟢") &&
              (item.exec?.bestAsk == null || item.exec.bestAsk <= 0.9)
            ) {
              const second = await consultLlm(item, ":v2");
              if (second != null) {
                const agrees =
                  isDirectionalStance(second.stance) &&
                  polarity(second.stance) === polarity(item.llm.stance);
                if (!agrees) item.llmRevoteMismatch = second;
              }
            }
          }
          // M5 增量交叉:先记账,后比对(姊妹市场共享同一官方文本)。
          if (item.llm?.eventStatus && item.updates.length > 0) {
            const key = item.updates[item.updates.length - 1].text;
            if (!esSeenFast.has(key)) esSeenFast.set(key, new Set());
            const set = esSeenFast.get(key)!;
            set.add(item.llm.eventStatus);
            if (set.has("decided") && set.has("pending")) item.esConflict = true;
          }
          // 自动下单:快路径是全系统延迟最敏感的时刻(断崖 2-5min),执行先于
          // 发信;batch 路径同样执行(邮件合并只是通知路由,不是执行路由)。
          // 邮件失败重试导致的重复检出由执行器 ledger 按 tokenId 去重兜住。
          await maybeExecuteTrade(item);
          const latencyS = Math.round((Date.now() - e.commitAtMs) / 1000);
          if (fired >= PREARM_FIRE_SOLO_MAX) {
            batchPending.set(qid, { e, item, latencyS });
            // 立即记账"见过新文本":批量邮件若恰在窗口尾部失败,条目出窗过期
            // 也不发假"无澄清落地"面包屑(核验发现的回归;邮件本身下 tick 重试)。
            e.sawUpdate = true;
            continue;
          }
          const pr = priorityOf(item);
          const searchUrl = item.title
            ? `https://polymarket.com/search?q=${encodeURIComponent(safeSlice(item.title, 80))}`
            : "https://polymarket.com";
          const execBit =
            item.exec?.bestAsk != null
              ? ` | 价${item.exec.bestAsk.toFixed(2)} 深$${Math.round(item.exec.askUsdNear)}${item.exec.executable ? "" : "⚠"}`
              : "";
          const llmLine = item.llm
            ? isDirectionalStance(item.llm.stance)
              ? `<div style="margin-top:2px"><b style="color:#2563eb">LLM 判读: ${escapeHtml(item.llm.stance)} (${escapeHtml(item.llm.confidence)}, via=llm)</b>${item.llm.eventStatus ? `<span style="font-size:12px;color:#888"> · 事件${item.llm.eventStatus === "decided" ? "已决" : item.llm.eventStatus === "pending" ? "未决⚠" : "状态不明"}</span>` : ""}${item.esConflict ? `<span style="font-size:12px;color:#d97706"> · 同簇es不一致⚠</span>` : ""}${item.llmRevoteMismatch ? `<div style="font-size:12px;color:#d97706">复判二票: ${escapeHtml(item.llmRevoteMismatch.stance)} — 已降档</div>` : ""}${item.llm.evidence ? `<div style="font-size:12px;color:#666">依据: "${escapeHtml(item.llm.evidence)}"</div>` : ""}</div>`
              : `<div style="margin-top:2px;font-size:12px;color:#888">LLM 判读: ${escapeHtml(item.llm.stance)} (${escapeHtml(item.llm.confidence)})</div>`
            : "";
          const execLine =
            item.exec?.bestAsk != null
              ? `<div style="margin-top:2px;font-size:13px"><b style="color:${item.exec.executable ? "#16a34a" : "#d97706"}">盘口: 买 ${escapeHtml(item.exec.outcome)} @${item.exec.bestAsk.toFixed(3)} · 近档深度 $${Math.round(item.exec.askUsdNear)}</b>${item.exec.fill100 ? ` · $100 市价单均价 ${item.exec.fill100.avgPrice.toFixed(3)}` : ""}${item.exec.marketUrl ? ` · <a href="${item.exec.marketUrl}">直达市场</a>` : ""}</div>`
              : "";
          await sendMail({
            subject: `[PredEdge链上] ⏰预告兑现 ${pr.label}${execBit}${tradeSubjectBit(item)} | ${safeSlice(item.title ?? qid, 48)}`,
            html: `<div style="font-family:system-ui,sans-serif;max-width:640px">
              <p><b>预告澄清承诺兑现</b>:承诺时点 ${new Date(e.commitAtMs).toISOString().slice(0, 16).replace("T", " ")}Z → 快轮询检出 ${latencyS >= 0 ? "+" : ""}${latencyS}s(bt5:入场断崖在 2-5 分钟,此刻是窗口)。</p>
              <div style="font-weight:600">${escapeHtml(item.title ?? qid)}</div>
              <div style="margin-top:4px">${isDirectionalStance(item.stance) ? `<b style="color:#d97706">官方方向: ${escapeHtml(item.stance)} (${escapeHtml(item.confidence)})</b>` : `正则立场: ${escapeHtml(item.stance)} (${escapeHtml(item.confidence)})`}</div>
              ${item.correction ? `<div style="margin-top:2px;font-size:13px;color:#dc2626"><b>🔄 此文本更正/撤回此前裁定 —— 核对新旧方向后再动。</b></div>` : ""}
              ${llmLine}
              ${execLine}
              ${tradeLineHtml(item)}
              ${item.excerpt ? `<div style="font-size:12px;color:#aaa;margin-top:4px">"${escapeHtml(item.excerpt)}"</div>` : ""}
              <div style="margin-top:4px"><a href="${searchUrl}">在 Polymarket 搜索</a> · qid ${escapeHtml(qid.slice(0, 10))}…</div>
              <p style="font-size:12px;color:#888">盘口为发信时刻快照;预告模板家族属绿档负收益家族(bt5/E3b),审慎对待。</p>
            </div>`,
            text: `预告兑现 +${latencyS}s | ${item.title ?? qid} | ${pr.label} | stance=${item.stance}(${item.confidence})${item.llm && isDirectionalStance(item.llm.stance) ? ` llm=${item.llm.stance}(${item.llm.confidence})` : ""}${item.exec?.bestAsk != null ? ` ask=${item.exec.bestAsk.toFixed(3)}` : ""}${tradeTextBit(item)}`,
          });
          fired += 1;
          markFired(qid, e, item, pr.rank);
          // 兑现文本本身可能是新预告(改期):统一走 maybeArm(48h 上界与指纹
          // 携带一体适用),新窗口自动重定位(核验发现的 >48h 改期残留边缘)。
          maybeArm(item);
          saveState(state);
        } catch (err) {
          // RPC/SMTP 瞬断:firedFp 未置位,下一轮重新检出即重试(at-least-once)。
          // 必须留日志:这是全系统最高价值的发信时刻,静默失败不可接受。
          console.warn(
            `[chain-watch] P1 快轮询 ${qid.slice(0, 10)} 处理失败(下轮重试): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      if (elapsed() + PREARM_POLL_MS >= PREARM_LOOP_END_MS) break;
      await new Promise((resolve) => setTimeout(resolve, PREARM_POLL_MS));
    }
    // 批量冲洗:第 PREARM_FIRE_SOLO_MAX+1 个起的兑现合并单封。失败不置
    // firedFp,下一 tick 重新检出重试(独立额度重置,届时前几个又可独立发)。
    if (batchPending.size > 0) {
      try {
        const rows = [...batchPending.entries()]
          .map(([qid, { item, latencyS }]) => {
            const pr = priorityOf(item);
            return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:13px">
              ${escapeHtml(item.title ?? qid)}<br>
              <span style="font-size:12px;color:#888">${escapeHtml(pr.label)} · +${latencyS}s · stance=${escapeHtml(item.stance)}(${escapeHtml(item.confidence)})${item.llm && isDirectionalStance(item.llm.stance) ? ` · llm=${escapeHtml(item.llm.stance)}` : ""}${item.exec?.bestAsk != null ? ` · 价${item.exec.bestAsk.toFixed(3)} 深$${Math.round(item.exec.askUsdNear)}` : ""}${item.exec?.marketUrl ? ` · <a href="${item.exec.marketUrl}">市场</a>` : ""}</span>
              ${tradeLineHtml(item)}
            </td></tr>`;
          })
          .join("\n");
        await sendMail({
          subject: `[PredEdge链上] ⏰预告批量兑现 ×${batchPending.size}(同刻姊妹市场合并)`,
          html: `<div style="font-family:system-ui,sans-serif;max-width:640px"><p>本 tick 兑现超过 ${PREARM_FIRE_SOLO_MAX} 个(批量定时澄清),余下合并如下:</p><table style="width:100%;border-collapse:collapse">${rows}</table><p style="font-size:12px;color:#888">盘口为检出时刻快照;预告模板家族属绿档负收益家族(bt5/E3b),审慎对待。</p></div>`,
          text: [...batchPending.entries()]
            .map(([qid, { item, latencyS }]) => `${item.title ?? qid} | ${priorityOf(item).label} | +${latencyS}s | stance=${item.stance}`)
            .join("\n"),
        });
        for (const [qid, { e, item }] of batchPending) {
          fired += 1;
          markFired(qid, e, item, priorityOf(item).rank);
          maybeArm(item); // 兑现文本本身是新预告(改期)时重定位窗口
        }
        saveState(state);
      } catch (err) {
        console.warn(
          `[chain-watch] P1 批量兑现邮件发送失败(下一 tick 重新检出): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    console.log(
      JSON.stringify({
        mode: "chain-watch-prearm",
        polls,
        fired,
        batched: batchPending.size || undefined,
        armed: Object.keys(state.preArm).length,
      })
    );
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
        exec_mode: executionMode() !== "off" ? executionMode() : undefined,
        trade_attempts: mailable.filter((n) => n.trade).length || undefined,
        trade_filled:
          mailable.filter((n) => n.trade && (n.trade.status === "filled" || n.trade.status === "partial"))
            .length || undefined,
        v2_watch: Object.keys(state.v2Watch).length || undefined,
        v2_polled: v2Polled || undefined,
        pre_armed: Object.keys(state.preArm).length || undefined,
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
    await flushPreArmMail();
    logSummary(0);
    await runPreArmFastLoop();
    return;
  }

  immediate.sort((a, b) => priorityOf(a).rank - priorityOf(b).rank);
  const top = immediate[0];
  const topTitle = safeSlice(top.title ?? top.qid, 48);
  // I1 主题行注解:价与深度直接可见,"深$"不足 $100 挂 ⚠(87% 的通知属于此类)。
  const topExecBit = top.exec
    ? top.exec.bestAsk != null
      ? ` | 价${top.exec.bestAsk.toFixed(2)} 深$${Math.round(top.exec.askUsdNear)}${top.exec.executable ? "" : "⚠"}`
      : " | 无盘口⚠"
    : "";
  const subject = `[PredEdge链上] ${priorityOf(top).label}${topExecBit}${tradeSubjectBit(top)} | ${topTitle}${immediate.length > 1 ? ` 等${immediate.length}个` : ""}`;

  const rows = immediate
    .map((n) => {
      const searchUrl = n.title
        ? `https://polymarket.com/search?q=${encodeURIComponent(safeSlice(n.title, 80))}`
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
          ? `<div style="margin-top:2px"><b style="color:#2563eb">LLM 判读: ${escapeHtml(n.llm.stance)} (${escapeHtml(n.llm.confidence)}, via=llm)</b>${n.llm.eventStatus ? `<span style="font-size:12px;color:#888"> · 事件${n.llm.eventStatus === "decided" ? "已决" : n.llm.eventStatus === "pending" ? "未决⚠" : "状态不明"}</span>` : ""}${n.esConflict ? `<span style="font-size:12px;color:#d97706"> · 同簇es不一致⚠(同一官方文本在姊妹市场判出相反事件状态,核对时点)</span>` : ""}${n.llmRevoteMismatch ? `<div style="font-size:12px;color:#d97706">复判二票: ${escapeHtml(n.llmRevoteMismatch.stance)} (${escapeHtml(n.llmRevoteMismatch.confidence)}) — ${isDirectionalStance(n.llmRevoteMismatch.stance) ? "与首票极性相反" : "二票收回方向"},已降档</div>` : ""}${n.llm.evidence ? `<div style="font-size:12px;color:#666">依据: "${escapeHtml(n.llm.evidence)}"</div>` : ""}${n.llm.reasoning ? `<div style="font-size:12px;color:#888">${escapeHtml(n.llm.reasoning)}</div>` : ""}</div>`
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
      const riskNote = disputeRiskNote(n);
      const riskLine = riskNote
        ? `<div style="margin-top:2px;font-size:12px;color:#d97706">${escapeHtml(riskNote)}</div>`
        : "";
      const correctionLine = n.correction
        ? `<div style="margin-top:2px;font-size:13px;color:#dc2626"><b>🔄 此文本更正/撤回此前裁定 —— 市场可能仍按旧裁定定价(bt5/E2:历史全部真方向翻转均为此形态),核对新旧方向后再动。</b></div>`
        : "";
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #333">
          <div style="font-weight:600">${escapeHtml(n.title ?? n.qid)}</div>
          <div style="font-size:12px;color:#888">${kindLabel} · updates=${n.updateCount}${n.refundClause ? " · ⚠️refund条款" : ""}${degradedTag}</div>
          <div style="margin-top:4px">${stanceLine}</div>
          ${correctionLine}
          ${llmLine}
          ${execLine}
          ${tradeLineHtml(n)}
          ${riskLine}
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
      const riskBit = disputeRiskNote(n) ? ` ${disputeRiskNote(n)}` : "";
      return `${n.title ?? n.qid} | ${[...n.kinds].join("+")} | stance=${n.stance}(${n.confidence})${llmBit}${execBit}${n.correction ? " CORRECTION" : ""}${riskBit}${n.refundClause ? " REFUND" : ""}${tradeTextBit(n)}`;
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
  await flushPreArmMail();
  logSummary(immediate.length);
  await runPreArmFastLoop();
}

main().catch((err) => {
  console.error(`[chain-watch] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
