/**
 * Chain-only dispute watcher — the degraded-network mode for remote boxes
 * that can reach Polygon RPCs but NOT gamma-api/clob (SNI-blocked, e.g. the
 * sufe deployment without a proxy).
 *
 * Every cron tick (default 3 min) it sweeps QuestionReset +
 * AncillaryDataUpdated events since the last tick, reads the question title
 * and official context straight from the chain, classifies the official
 * stance, and emails when something notification-worthy happened:
 *   - an official context update with a directional stance (highest value —
 *     the 32/32 signal class), or
 *   - a market entering the dispute flow (QuestionReset).
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
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { sendMail } from "./mailer";
import { ethCall } from "../lib/polymarket/oracleState";
import { getOfficialUpdates, stanceFromText, detectRefundClause } from "../lib/polymarket/officialContext";
import { isDirectionalStance } from "../lib/virtualTags";
import { KNOWN_ADAPTERS } from "../lib/polymarket/onchainEvents";

const TOPIC_QUESTION_RESET =
  "0x7981b5832932948db4e32a4a16a0f44b2ce7ff088574afb9364b313f70f82e8f";
const TOPIC_ANCILLARY_UPDATED =
  "0x0059e11815211969c0c4aaf3f498b52b6c2f2d14f286275d0862d70de22a836b";
const GET_QUESTION_SELECTOR = "0x58c039cd";

// Max lookback after downtime: ~600 blocks ≈ 20 minutes. publicnode only
// serves getLogs hugging the chain head (~127 blocks), so deeper pages fall
// through to the fallback RPCs (drpc etc.) that allow ~100-block windows at
// any depth. Beyond 600 blocks we accept the gap (noted in the email)
// instead of hammering free tiers with a huge catch-up sweep.
const HEAD_WINDOW = 600;

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
  let lastError: Error | null = null;
  for (const url of rpcUrls()) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(timer);
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

interface WatchState {
  lastBlock: number;
  /** qid → fingerprint of the last notified condition (event kinds + update count + stance). */
  notified: Record<string, string>;
}

function statePath(): string {
  const configured = process.env.CHAIN_WATCH_STATE?.trim();
  if (configured) return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  return path.join(process.cwd(), "data", "chain-watch-state.json");
}

function loadState(): WatchState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8"));
    return {
      lastBlock: Number(raw.lastBlock) || 0,
      notified: raw.notified && typeof raw.notified === "object" ? raw.notified : {},
    };
  } catch {
    return { lastBlock: 0, notified: {} };
  }
}

function saveState(state: WatchState): void {
  mkdirSync(path.dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 1));
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
}

async function main(): Promise<void> {
  const state = loadState();
  const head = Number(await rpc<string>("eth_blockNumber", []));
  if (!Number.isFinite(head) || head <= 0) throw new Error(`bad head: ${head}`);

  const idealFrom = state.lastBlock > 0 ? state.lastBlock + 1 : head - HEAD_WINDOW;
  const from = Math.max(idealFrom, head - HEAD_WINDOW);
  const gap = from > idealFrom ? from - idealFrom : 0;
  if (from > head) {
    console.log(JSON.stringify({ mode: "chain-watch", head, skipped: "no new blocks" }));
    return;
  }

  // Fetch in ≤48-block windows — the strictest free-tier getLogs cap seen
  // (1rpc allows 50; publicnode ~127 near the head). A window that fails on
  // every RPC stops the sweep, but progress up to it is kept: the swept
  // range is processed and persisted, the rest retried next tick — so one
  // bad page no longer voids the whole tick (that's how 12% of blocks got
  // permanently skipped in the first day of deployment).
  const logs: Array<{ address: string; topics: string[] }> = [];
  const WINDOW = 48;
  let sweptTo = from - 1;
  let sweepError: string | null = null;
  for (let start = from; start <= head; start += WINDOW) {
    const end = Math.min(start + WINDOW - 1, head);
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
      });
    }
    byQid.get(qid)!.kinds.add(kind);
  }

  // Enrich each with title + official context read straight from the chain
  for (const item of byQid.values()) {
    item.title = await fetchQuestionTitle(item.adapter, item.qid);
    try {
      const { updates } = await getOfficialUpdates({ resolvedBy: item.adapter, questionID: item.qid });
      item.updateCount = updates.length;
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

  // Decide what's notification-worthy and not already notified
  const notable = [...byQid.values()].filter((item) => {
    const fingerprint = `${[...item.kinds].sort().join("+")}:${item.updateCount}:${item.stance}`;
    if (state.notified[item.qid] === fingerprint) return false;
    state.notified[item.qid] = fingerprint;
    return true;
  });

  state.lastBlock = sweptTo;
  // Bound the notified map (~keep last 500 entries)
  const keys = Object.keys(state.notified);
  if (keys.length > 500) {
    for (const k of keys.slice(0, keys.length - 500)) delete state.notified[k];
  }
  saveState(state);

  if (notable.length === 0) {
    console.log(
      JSON.stringify({ mode: "chain-watch", from, to: sweptTo, events: logs.length, notified: 0, gap, sweep_error: sweepError ?? undefined })
    );
    return;
  }

  const directional = notable.filter((n) => isDirectionalStance(n.stance));
  const subject = `[PredEdge 链上] ${notable.length} 个争议事件${directional.length > 0 ? ` (${directional.length} 个官方方向!)` : ""}`;

  const rows = notable
    .map((n) => {
      const searchUrl = n.title
        ? `https://polymarket.com/search?q=${encodeURIComponent(n.title.slice(0, 80))}`
        : `https://polymarket.com`;
      const kindLabel = [...n.kinds]
        .map((k) => (k === "reset" ? "争议重置(QuestionReset)" : "官方context更新"))
        .join(" + ");
      const stanceLine = isDirectionalStance(n.stance)
        ? `<b style="color:#d97706">官方方向: ${n.stance} (${n.confidence})</b>`
        : `立场: ${n.stance} (${n.confidence})`;
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #333">
          <div style="font-weight:600">${n.title ?? n.qid}</div>
          <div style="font-size:12px;color:#888">${kindLabel} · updates=${n.updateCount}${n.refundClause ? " · ⚠️refund条款" : ""}</div>
          <div style="margin-top:4px">${stanceLine}</div>
          ${n.excerpt ? `<div style="font-size:12px;color:#aaa;margin-top:4px">"${n.excerpt.replace(/</g, "&lt;")}"</div>` : ""}
          <div style="margin-top:4px"><a href="${searchUrl}">在 Polymarket 搜索</a> · qid ${n.qid.slice(0, 10)}…</div>
        </td></tr>`;
    })
    .join("\n");

  const html = `<div style="font-family:system-ui,sans-serif;max-width:640px">
    <p>链上监听(纯 RPC 模式,无价格数据)在块 ${from}–${sweptTo} 发现:</p>
    ${gap > 0 ? `<p style="color:#d97706">⚠️ 距上次运行跳过了 ${gap} 个块(停机追赶超出免费 RPC 回看窗口)。</p>` : ""}
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="font-size:12px;color:#888">直接买入前先在 App 确认盘口价格;分歧机会请核对官方文本与市场方向。</p>
  </div>`;

  const text = notable
    .map((n) => `${n.title ?? n.qid} | ${[...n.kinds].join("+")} | stance=${n.stance}(${n.confidence})${n.refundClause ? " REFUND" : ""}`)
    .join("\n");

  await sendMail({ subject, html, text });
  console.log(
    JSON.stringify({
      mode: "chain-watch",
      from,
      to: sweptTo,
      events: logs.length,
      notified: notable.length,
      directional: directional.length,
      gap,
      sweep_error: sweepError ?? undefined,
    })
  );
}

main().catch((err) => {
  console.error(`[chain-watch] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
