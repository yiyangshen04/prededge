/**
 * 无头扫描 + 邮件通知 CLI — cron 入口。
 *
 * 用法:
 *   npm run scan:notify        (等价于 npx tsx scripts/scan-notify.ts)
 *
 * 流程:
 *   1. 探测 Gamma API 可达性(10s 超时);
 *      - 可达   → 完整模式 runScan(DEFAULT_SCAN_CONFIG)
 *      - 不可达 → 打印日志后退出(纯链上降级模式尚未接入,见 runChainOnlyMode)
 *   2. 从 opportunities 里筛"值得通知的机会"(见 isNotifiable);
 *   3. 用 data/notify-state.json 去重防轰炸:只有新 tokenId、或 decision /
 *      officialContext.stance 变化的机会才进入本次邮件;
 *   4. 有新内容 → 发 HTML 邮件;全无新内容 → 不发,日志说明;
 *   5. 结尾打印一行 JSON 摘要,方便 cron 日志 grep。
 *
 * 退出码: 0 正常(含"无新内容不发邮件"),1 异常,2 Gamma 不可达且降级模式未接入。
 */
import fs from "node:fs";
import path from "node:path";
import { runScan } from "../lib/polymarket/scanner";
import { DEFAULT_SCAN_CONFIG } from "../lib/polymarket/config";
import type { Opportunity, ScanResponse } from "../lib/types";
import { renderOpportunitiesEmail, sendMail } from "./mailer";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(PROJECT_ROOT, "data", "notify-state.json");
const GAMMA_PROBE_URL = "https://gamma-api.polymarket.com/markets?limit=1";
const GAMMA_PROBE_TIMEOUT_MS = 10_000;

// ── Gamma 可达性探测 ──

async function probeGamma(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GAMMA_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(GAMMA_PROBE_URL, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── 降级模式(未实现,仅接入点)──

/**
 * TODO(chain-only): 纯链上降级模式 — Gamma 不可达时,不经 Gamma,直接从链上
 * (UMA CTF Adapter 事件 / CLOB)重建争议市场机会清单,返回与完整模式同形的
 * ScanResponse,之后复用下面 main() 里同一套筛选/去重/邮件流程。
 * 具体实现稍后接入;当前版本不要调用。
 */
async function runChainOnlyMode(): Promise<ScanResponse> {
  throw new Error("chain-only degraded mode 尚未实现(接入点占位)");
}

// ── 筛选:值得通知的机会 ──

function isNotifiable(o: Opportunity): boolean {
  const reasons = o.decisionReasons ?? [];
  // b. 官方分歧形态 — 最高优先,无条件通知
  if (reasons.includes("official_divergence_play")) return true;
  // a. UMA 状态为 disputed 且 decision 为 actionable
  const uma = (o.umaResolutionStatus ?? "").trim().toLowerCase();
  if (uma === "disputed" && o.decision === "actionable") return true;
  // c. 官方方向背书,且未被拒绝
  if (reasons.includes("official_direction_backed") && o.decision !== "rejected") {
    return true;
  }
  return false;
}

// ── 去重状态(data/notify-state.json)──

interface NotifyStateEntry {
  lastDecision: string;
  lastStance: string | null;
  notifiedAt: string;
}

type NotifyState = Record<string, NotifyStateEntry>;

function loadState(): NotifyState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as NotifyState;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[scan-notify] 状态文件 ${STATE_FILE} 读取/解析失败,按空状态处理:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return {};
}

function saveState(state: NotifyState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** 新 tokenId,或 decision / officialContext.stance 相对上次通知发生变化。 */
function isNewOrChanged(state: NotifyState, o: Opportunity): boolean {
  const prev = state[o.tokenId];
  if (!prev) return true;
  const stance = o.officialContext?.stance ?? null;
  return prev.lastDecision !== o.decision || (prev.lastStance ?? null) !== stance;
}

// ── 主流程 ──

async function main(): Promise<void> {
  console.log(`[scan-notify] ${new Date().toISOString()} 启动,探测 Gamma 可达性…`);
  const gammaOk = await probeGamma();

  if (!gammaOk) {
    console.error(
      `[scan-notify] Gamma API 不可达(${GAMMA_PROBE_URL},超时 ${GAMMA_PROBE_TIMEOUT_MS / 1000}s)。`
    );
    console.error(
      "[scan-notify] 纯链上降级模式尚未接入(见 runChainOnlyMode 接入点),本次退出。"
    );
    // TODO(chain-only): 降级模式接入后,把上面两行 + exit 换成:
    //   const response = await runChainOnlyMode();
    //   mode = "chain_only"; 然后走下方同一套筛选/去重/邮件流程。
    process.exit(2);
  }

  const mode = "full";
  console.log("[scan-notify] Gamma 可达,进入完整模式扫描…");
  const response = await runScan(DEFAULT_SCAN_CONFIG);
  const { scan, opportunities } = response;
  console.log(
    `[scan-notify] 扫描完成 scanId=${scan.scanId},共 ${opportunities.length} 个机会` +
      `(actionable=${scan.actionableCount}, observe=${scan.observeCount}, rejected=${scan.rejectedCount})`
  );

  const notifiable = opportunities.filter(isNotifiable);
  const state = loadState();
  const toNotify = notifiable.filter((o) => isNewOrChanged(state, o));
  console.log(
    `[scan-notify] 符合通知条件 ${notifiable.length} 个,其中新增/状态变化 ${toNotify.length} 个。`
  );

  if (toNotify.length === 0) {
    console.log("[scan-notify] 无新内容(全部已通知过且 decision/stance 未变化),不发邮件。");
  } else {
    const email = renderOpportunitiesEmail(toNotify, scan);
    const { messageId } = await sendMail(email);
    console.log(`[scan-notify] 邮件已发送 messageId=${messageId},主题: ${email.subject}`);

    // 发送成功后才写回状态,发送失败则下次重试。
    const notifiedAt = new Date().toISOString();
    for (const o of toNotify) {
      state[o.tokenId] = {
        lastDecision: o.decision,
        lastStance: o.officialContext?.stance ?? null,
        notifiedAt,
      };
    }
    saveState(state);
  }

  // cron 日志 grep 用的一行 JSON 摘要
  console.log(
    JSON.stringify({
      scanId: scan.scanId,
      opportunities: opportunities.length,
      notified: toNotify.length,
      mode,
    })
  );
}

main().catch((err) => {
  console.error("[scan-notify] 未捕获异常:", err);
  process.exit(1);
});
