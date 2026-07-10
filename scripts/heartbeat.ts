/**
 * 心跳监控 + 日报 — cron 入口。
 *
 * 用法:
 *   npx tsx scripts/heartbeat.ts --watch   每 10 分钟:两条通道超龄则发告警邮件,恢复发恢复邮件
 *   npx tsx scripts/heartbeat.ts --daily   每天 09:05:发运行日报(本身就是"系统活着"的日频心跳)
 *
 * 判活依据:run-cron.sh 在脚本 exit 0 后 touch 的 data/last-ok-<name> 标记文件
 * (chain-watch 兜底用 data/chain-watch-state.json,它每次成功 tick 都会重写)。
 * 告警只在状态翻转时发一次(ok→down / down→ok),状态存 data/heartbeat-state.json。
 * 日报统计基于日志字节 offset("自上次日报以来"),周日日志截断后自动归零重来。
 *
 * §3.1 静默单点探针(2026-07-11):mtime 判活只覆盖"进程死了",四个单点挂掉
 * 后进程照常 exit 0、监控全绿,系统却已实质停摆:
 *   探针 0 SMTP    — verify 握手,失败即 exit≠0 → run-cron 不 ping
 *                    HC_PING_HEARTBEAT → healthchecks.io 从外部拉响(SMTP
 *                    死了邮件自报是不可能的,这是唯一出路);
 *   探针 1 kill-switch — trading-halt 文件存在(自动熔断落的)即告警;
 *   探针 2 Clash   — 经代理探 gamma-api,连续 2 次(≈20min)失败告警;
 *   探针 3 claude  — 每小时跑一次 claude -p 探针,连续 2 次(≈2h)失败告警
 *                    (登录态失效时 LLM 判读静默 fail-open,🟢/自动下单闸门
 *                    整体消失而邮件表面全绿)。
 *
 * 注意:本机(sufe)整机死亡时本脚本同样死亡 —— 这层只报"进程还在但坏了";
 * "整机被清"必须靠外部 healthchecks.io(见 run-cron.sh 的 HC_PING_*)。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { sendMail, verifySmtp } from "./mailer";
import { writeFileAtomic } from "../lib/fsAtomic";

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const LOGS = path.join(ROOT, "logs");
const STATE_FILE = path.join(DATA, "heartbeat-state.json");

interface Channel {
  key: string;
  label: string;
  /** 按优先级取第一个存在的文件的 mtime 作为"最后成功时间" */
  markers: string[];
  log: string;
  staleMinutes: number;
}

const CHANNELS: Channel[] = [
  {
    key: "chain-watch",
    label: "chain-watch(哨兵/3分钟)",
    markers: [path.join(DATA, "last-ok-chain-watch"), path.join(DATA, "chain-watch-state.json")],
    log: path.join(LOGS, "chain-watch.log"),
    staleMinutes: 15, // 5 个 tick 全失败才算 down,容忍单次 RPC 抖动
  },
  {
    key: "scan-notify",
    label: "scan-notify(巡逻/30分钟)",
    markers: [path.join(DATA, "last-ok-scan-notify")],
    log: path.join(LOGS, "scan-notify.log"),
    staleMinutes: 130, // 4 个 tick;Gamma 偶发不可达不告警,持续挂(如 Clash 死)才告警
  },
];

// ── 状态 ──

interface AlertEntry {
  status: "ok" | "down";
  since: string;
}

interface HeartbeatState {
  alert: Record<string, AlertEntry>;
  offsets: Record<string, number>;
  /** st_ino of each log at the time its offset was recorded. When the log is
   * rotated (tail -c ... > tmp && mv changes the inode) the byte offset is
   * meaningless against the new file, so a changed inode forces a from-0
   * reread instead of the offset-vs-size heuristic (which mis-fires when the
   * rotated file is smaller than the old offset). */
  logInodes: Record<string, number>;
  lastDigestAt: string | null;
  /** §3.1 探针连续失败计数(达到阈值才翻转告警,容忍单次网络抖动)。 */
  probeFails: Record<string, number>;
  /** claude 登录态探针的上次执行时刻(小时级节流,每次探针都是一次真调用)。 */
  lastClaudeProbeAt: string | null;
}

function loadState(): HeartbeatState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      alert: raw.alert && typeof raw.alert === "object" ? raw.alert : {},
      offsets: raw.offsets && typeof raw.offsets === "object" ? raw.offsets : {},
      logInodes: raw.logInodes && typeof raw.logInodes === "object" ? raw.logInodes : {},
      lastDigestAt: typeof raw.lastDigestAt === "string" ? raw.lastDigestAt : null,
      probeFails: raw.probeFails && typeof raw.probeFails === "object" ? raw.probeFails : {},
      lastClaudeProbeAt: typeof raw.lastClaudeProbeAt === "string" ? raw.lastClaudeProbeAt : null,
    };
  } catch {
    return { alert: {}, offsets: {}, logInodes: {}, lastDigestAt: null, probeFails: {}, lastClaudeProbeAt: null };
  }
}

function saveState(state: HeartbeatState): void {
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 1) + "\n");
}

// ── 工具 ──

function fmtTime(d: Date): string {
  return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 最后成功时间(取存在的标记文件里最新的 mtime);全都不存在返回 null。 */
function lastOkAt(ch: Channel): Date | null {
  let best: Date | null = null;
  for (const p of ch.markers) {
    try {
      const m = fs.statSync(p).mtime;
      if (!best || m > best) best = m;
    } catch {
      // 文件不存在 — 试下一个
    }
  }
  return best;
}

function ageMinutes(d: Date): number {
  return Math.round((Date.now() - d.getTime()) / 60_000);
}

function tailLines(file: string, n: number): string[] {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    const len = Math.min(size, 16_384);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString("utf8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

// ── §3.1 静默单点探针 ──

const HALT_KEY = "trading-halt";
const PROXY_KEY = "proxy-gamma";
const CLAUDE_KEY = "claude-login";
/** 连续失败达到该次数才翻转 down(容忍单次网络抖动)。 */
const PROBE_FAIL_THRESHOLD = 2;

function haltFilePath(): string {
  const p = process.env.EXEC_HALT_FILE?.trim() || "data/trading-halt";
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/** Gamma 经代理(heartbeat 在 run-cron 下继承 HTTPS_PROXY+NODE_USE_ENV_PROXY,
 * 走的正是 scan-notify/盘口注解/自动下单同一条 Clash 路径)。 */
async function probeGamma(): Promise<boolean> {
  try {
    const res = await fetch("https://gamma-api.polymarket.com/markets?limit=1", {
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** claude CLI 登录态:与 llmStance.runClaude 同一 bin/参数形态/env 白名单的
 * 最小真实调用(登录态失效只有真调用才暴露)。 */
function probeClaude(): Promise<{ ok: boolean; detail: string }> {
  const bin = process.env.CLAUDE_BIN?.trim() || "claude";
  const model = process.env.LLM_STANCE_MODEL?.trim() || "claude-opus-4-8";
  const args = ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--model", model];
  const allow = [
    "PATH", "HOME", "SHELL", "USER", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
    "NODE_USE_ENV_PROXY", "TMPDIR", "LANG", "LC_ALL", "TERM",
  ];
  const env = {} as NodeJS.ProcessEnv;
  for (const k of allow) if (process.env[k] !== undefined) env[k] = process.env[k];
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, cwd: os.tmpdir(), env },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, detail: `${err.message}${stderr ? ` | ${String(stderr).slice(0, 200)}` : ""}` });
          return;
        }
        try {
          const wrapper = JSON.parse(String(stdout)) as { is_error?: boolean; result?: unknown };
          if (wrapper?.is_error) {
            resolve({ ok: false, detail: `is_error: ${String(wrapper.result).slice(0, 200)}` });
            return;
          }
          resolve({ ok: true, detail: "" });
        } catch {
          resolve({ ok: false, detail: `非 JSON 输出: ${String(stdout).slice(0, 120)}` });
        }
      }
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end("只回复两个字:正常");
  });
}

// ── watch 模式:超龄告警 / 恢复通知 ──

async function watch(): Promise<void> {
  // 探针 0:SMTP。verify 失败即硬失败(exit≠0)—— run-cron 不 ping
  // HC_PING_HEARTBEAT,由 healthchecks.io 从外部拉响。SMTP 死了后面的一切
  // 告警邮件都发不出去,继续跑只是自欺。
  await verifySmtp();

  const state = loadState();
  const events: Array<{ ch: Channel; kind: "down" | "recovered"; detail: string }> = [];
  const summary: Record<string, string> = {};

  // 探针事件与通道告警共用同一封翻转邮件;probe 无日志文件(tail 为空)。
  const pushProbeEvent = (
    key: string,
    label: string,
    down: boolean,
    downDetail: string,
    recoverDetail: string
  ): void => {
    const prev = state.alert[key]?.status ?? "ok";
    const ch: Channel = { key, label, markers: [], log: "", staleMinutes: 0 };
    if (down && prev !== "down") {
      events.push({ ch, kind: "down", detail: downDetail });
      state.alert[key] = { status: "down", since: new Date().toISOString() };
    } else if (!down && prev === "down") {
      events.push({ ch, kind: "recovered", detail: recoverDetail });
      state.alert[key] = { status: "ok", since: new Date().toISOString() };
    }
    summary[key] = down ? "down" : "ok";
  };

  // 探针 1:kill-switch 文件。自动熔断(连续错误/连亏/ledger 写失败)只落
  // 本地文件,不报的话操作员可能几天不知道引擎已停。文件存在与否是确定态,
  // 不走连续失败阈值。
  {
    let haltContent: string | null = null;
    try {
      haltContent = fs.readFileSync(haltFilePath(), "utf8").slice(0, 400);
    } catch {
      haltContent = null;
    }
    pushProbeEvent(
      HALT_KEY,
      "自动交易 kill-switch(trading-halt)",
      haltContent != null,
      `kill-switch 文件存在,自动交易已全部停止:${haltFilePath()}\n内容:${haltContent || "(空)"}\n人工排查后删除该文件恢复。`,
      "kill-switch 已移除,自动交易恢复。"
    );
  }

  // 探针 2:Clash 代理(经代理访问 gamma-api)。
  {
    const ok = await probeGamma();
    const fails = ok ? 0 : (state.probeFails[PROXY_KEY] ?? 0) + 1;
    state.probeFails[PROXY_KEY] = fails;
    // 低于阈值的失败不翻转(保持原状态),单次成功即恢复。
    const down = fails >= PROBE_FAIL_THRESHOLD || (!ok && state.alert[PROXY_KEY]?.status === "down");
    pushProbeEvent(
      PROXY_KEY,
      "Gamma/代理连通(Clash 单点)",
      down,
      `连续 ${fails} 次无法经代理访问 gamma-api —— Clash 大概率已死。scan-notify 整通道、盘口注解、自动下单、结算对账全部依赖它;chain-watch 链上告警(直连 RPC)不受影响。`,
      "Gamma 经代理已恢复可达。"
    );
  }

  // 探针 3:claude CLI 登录态(每小时一次,每次是真调用)。
  {
    const last = state.lastClaudeProbeAt ? Date.parse(state.lastClaudeProbeAt) : 0;
    if (Date.now() - last > 55 * 60_000) {
      state.lastClaudeProbeAt = new Date().toISOString();
      const { ok, detail } = await probeClaude();
      const fails = ok ? 0 : (state.probeFails[CLAUDE_KEY] ?? 0) + 1;
      state.probeFails[CLAUDE_KEY] = fails;
      const down = fails >= PROBE_FAIL_THRESHOLD || (!ok && state.alert[CLAUDE_KEY]?.status === "down");
      pushProbeEvent(
        CLAUDE_KEY,
        "claude CLI 登录态(LLM 判读)",
        down,
        `连续 ${fails} 次 claude -p 探针失败:${detail || "无输出"}\nLLM 判读正在静默 fail-open —— 🟢 双确认档与自动下单闸门已实质停摆(只发 🟠),邮件表面全绿。ssh sufe 后重新 claude setup-token 并更新 .env 的 CLAUDE_CODE_OAUTH_TOKEN。`,
        "claude CLI 探针已恢复。"
      );
    } else {
      summary[CLAUDE_KEY] = state.alert[CLAUDE_KEY]?.status ?? "ok";
    }
  }

  for (const ch of CHANNELS) {
    const last = lastOkAt(ch);
    const prev = state.alert[ch.key]?.status ?? "ok";
    if (last == null) {
      summary[ch.key] = "unknown(尚无成功标记)";
      continue; // 部署初期标记还没生成 — 不判定
    }
    const age = ageMinutes(last);
    const now: "ok" | "down" = age > ch.staleMinutes ? "down" : "ok";
    summary[ch.key] = `${now}(最后成功 ${age} 分钟前)`;

    if (now === "down" && prev !== "down") {
      events.push({
        ch,
        kind: "down",
        detail: `最后一次成功运行在 ${fmtTime(last)}(${age} 分钟前),超过阈值 ${ch.staleMinutes} 分钟。`,
      });
      state.alert[ch.key] = { status: "down", since: new Date().toISOString() };
    } else if (now === "ok" && prev === "down") {
      const since = state.alert[ch.key]?.since;
      const downMin = since ? Math.round((Date.now() - Date.parse(since)) / 60_000) : null;
      events.push({
        ch,
        kind: "recovered",
        detail: `已恢复正常运行${downMin != null ? `(告警持续约 ${downMin} 分钟)` : ""}。`,
      });
      state.alert[ch.key] = { status: "ok", since: new Date().toISOString() };
    }
  }

  // Degradation check for chain-watch: it exits 0 (marker stays fresh) even
  // when only the first block window of each tick succeeds, so a marker-mtime
  // check alone never goes "down" while the cursor silently falls behind and
  // starts permanently skipping blocks. Inspect recent tick summaries for
  // persistent partial failures (sweep_error) or accumulating gap.
  {
    const chainCh = CHANNELS[0];
    const DEG_KEY = "chain-watch-degraded";
    const recent = tailLines(chainCh.log, 12).filter((l) => l.startsWith("{"));
    let samples = 0;
    let sweepErrs = 0;
    let gapSum = 0;
    let gapTicks = 0;
    for (const l of recent) {
      try {
        const j = JSON.parse(l);
        if (j.mode !== "chain-watch") continue;
        samples += 1;
        if (j.sweep_error) sweepErrs += 1;
        const g = Number(j.gap) || 0;
        gapSum += g;
        if (g > 0) gapTicks += 1;
      } catch {
        // non-JSON line — ignore
      }
    }
    // gap 要求至少 2 个 tick 都出现:停机后的首个追赶 tick 会一次性记录一个大
    // gap(chain-watch 自己已就此发过 gap 告警),那是已结束的历史事件;只有多个
    // tick 连续产生 gap 才说明"正在持续漏扫"。sweep_error 保持原判据。
    const degraded = samples >= 5 && (sweepErrs >= 5 || (gapTicks >= 2 && gapSum > 300));
    const prevDegraded = state.alert[DEG_KEY]?.status === "down";
    const degChannel: Channel = { ...chainCh, key: DEG_KEY };
    if (degraded && !prevDegraded) {
      events.push({
        ch: { ...degChannel, label: "chain-watch(持续部分失败 / 漏块)" },
        kind: "down",
        detail: `进程仍在运行(exit 0)但最近 ${samples} 个 tick 中 ${sweepErrs} 个部分失败,累计 gap ${gapSum} 块 —— 正在持续漏扫,监控 mtime 检查无法发现。`,
      });
      state.alert[DEG_KEY] = { status: "down", since: new Date().toISOString() };
    } else if (!degraded && prevDegraded) {
      events.push({
        ch: { ...degChannel, label: "chain-watch(部分失败已恢复)" },
        kind: "recovered",
        detail: "部分失败 / 漏块累积已恢复正常。",
      });
      state.alert[DEG_KEY] = { status: "ok", since: new Date().toISOString() };
    }
    summary[DEG_KEY] = degraded ? `degraded(${sweepErrs}/${samples} 部分失败, gap累计 ${gapSum})` : "ok";
  }

  if (events.length > 0) {
    const downs = events.filter((e) => e.kind === "down");
    const subject =
      downs.length > 0
        ? `[PredEdge 告警] ${downs.map((e) => e.ch.key).join(" + ")} 停止工作`
        : `[PredEdge 恢复] ${events.map((e) => e.ch.key).join(" + ")} 已恢复`;

    const blocks = events
      .map((e) => {
        const tail = tailLines(e.ch.log, 10)
          .map((l) => escapeHtml(l))
          .join("\n");
        return `<h3 style="margin:14px 0 4px;font-size:14px;color:${e.kind === "down" ? "#f87171" : "#34d399"}">${
          e.kind === "down" ? "⛔" : "✅"
        } ${escapeHtml(e.ch.label)}</h3>
        <p style="margin:0 0 6px">${escapeHtml(e.detail)}</p>
        ${tail ? `<pre style="background:#1b1f26;padding:8px 10px;border-radius:6px;font-size:11px;overflow-x:auto;color:#9aa3ad">${tail}</pre>` : ""}`;
      })
      .join("\n");

    const html = `<div style="background:#14171c;color:#e6e8eb;padding:18px 20px;border-radius:10px;font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;max-width:760px">
      <h2 style="margin:0 0 8px;font-size:16px">PredEdge 心跳监控</h2>
      ${blocks}
      <p style="margin:12px 0 0;font-size:11px;color:#6b7280">手动体检:ssh sufe 后 tail 各日志;本邮件由 scripts/heartbeat.ts --watch 发送,只在状态翻转时发一次。</p>
    </div>`;
    const text = events.map((e) => `${e.kind === "down" ? "DOWN" : "RECOVERED"}: ${e.ch.key} — ${e.detail}`).join("\n");

    await sendMail({ subject, html, text });
    // 发信成功后才落状态 — 发信失败则保持旧状态,下个 tick 重试
  }
  saveState(state);
  console.log(JSON.stringify({ mode: "heartbeat-watch", at: new Date().toISOString(), ...summary, mailed: events.length }));
}

// ── daily 模式:运行日报 ──

interface ChainStats {
  okTicks: number;
  fatalTicks: number;
  partialTicks: number;
  events: number;
  notified: number;
  directional: number;
  gapBlocks: number;
}

interface ScanStats {
  starts: number;
  fullOk: number;
  gammaUnreachable: number;
  mailsSent: number;
  lastOpportunities: number | null;
  lastNotified: number | null;
}

/**
 * Read new log bytes since the last offset. Rotation-aware: if the file's inode
 * changed since we recorded the offset (weekly `tail -c ... > tmp && mv`), the
 * old byte offset points into unrelated content, so we reread from 0. The plain
 * `offset > size` guard alone silently mis-aligns when the rotated file is
 * smaller than the old offset in a way that isn't a clean truncation.
 */
function readNewLog(
  file: string,
  offset: number,
  prevIno: number | undefined
): { content: string; nextOffset: number; ino: number | null } {
  try {
    const stat = fs.statSync(file);
    const size = stat.size;
    const ino = stat.ino;
    const rotated = prevIno != null && ino !== prevIno;
    const from = rotated || offset > size ? 0 : offset;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, size - from, from);
    fs.closeSync(fd);
    return { content: buf.toString("utf8"), nextOffset: size, ino };
  } catch {
    return { content: "", nextOffset: 0, ino: null };
  }
}

function chainStats(content: string): ChainStats {
  const s: ChainStats = { okTicks: 0, fatalTicks: 0, partialTicks: 0, events: 0, notified: 0, directional: 0, gapBlocks: 0 };
  for (const line of content.split("\n")) {
    if (line.includes("] fatal:")) {
      s.fatalTicks += 1;
      continue;
    }
    if (!line.startsWith("{")) continue;
    try {
      const j = JSON.parse(line);
      if (j.mode !== "chain-watch") continue;
      s.okTicks += 1;
      s.events += Number(j.events) || 0;
      s.notified += Number(j.notified) || 0;
      s.directional += Number(j.directional) || 0;
      s.gapBlocks += Number(j.gap) || 0;
      if (j.sweep_error) s.partialTicks += 1;
    } catch {
      // 非 JSON 行(堆栈等)忽略
    }
  }
  return s;
}

function scanStats(content: string): ScanStats {
  const s: ScanStats = { starts: 0, fullOk: 0, gammaUnreachable: 0, mailsSent: 0, lastOpportunities: null, lastNotified: null };
  for (const line of content.split("\n")) {
    if (line.includes("启动,探测 Gamma")) s.starts += 1;
    if (line.includes("Gamma API 不可达")) s.gammaUnreachable += 1;
    if (line.includes("邮件已发送")) s.mailsSent += 1;
    if (line.startsWith("{") && line.includes("scanId")) {
      try {
        const j = JSON.parse(line);
        s.fullOk += 1;
        s.lastOpportunities = Number(j.opportunities) ?? null;
        s.lastNotified = Number(j.notified) ?? null;
      } catch {
        // ignore
      }
    }
  }
  return s;
}

async function daily(): Promise<void> {
  const state = loadState();
  const now = new Date();
  const periodFrom = state.lastDigestAt ? fmtTime(new Date(state.lastDigestAt)) : "日志起点";

  const chainLog = readNewLog(
    CHANNELS[0].log,
    state.offsets["chain-watch"] ?? 0,
    state.logInodes["chain-watch"]
  );
  const scanLog = readNewLog(
    CHANNELS[1].log,
    state.offsets["scan-notify"] ?? 0,
    state.logInodes["scan-notify"]
  );
  const cs = chainStats(chainLog.content);
  const ss = scanStats(scanLog.content);

  const chainLast = lastOkAt(CHANNELS[0]);
  const scanLast = lastOkAt(CHANNELS[1]);
  const hcConfigured = Boolean(process.env.HC_PING_CHAIN_WATCH?.trim() && process.env.HC_PING_SCAN_NOTIFY?.trim());

  const subject = `[PredEdge 日报] 哨兵 ${cs.okTicks}✓/${cs.fatalTicks}✗ · 巡逻 ${ss.fullOk}✓/${ss.gammaUnreachable}✗ — ${fmtTime(now).slice(5, 16)}`;

  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#9aa3ad;white-space:nowrap">${k}</td><td style="padding:4px 0">${v}</td></tr>`;

  const gapMinutes = Math.round((cs.gapBlocks * 2.1) / 60);
  const html = `<div style="background:#14171c;color:#e6e8eb;padding:18px 20px;border-radius:10px;font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;max-width:760px">
  <h2 style="margin:0 0 4px;font-size:16px">PredEdge 运行日报</h2>
  <p style="margin:0 0 12px;font-size:12px;color:#9aa3ad">统计区间:${escapeHtml(periodFrom)} → ${escapeHtml(fmtTime(now))}</p>

  <h3 style="margin:10px 0 4px;font-size:14px;color:#7dd3fc">通道一 chain-watch(哨兵,3 分钟)</h3>
  <table style="font-size:13px;border-collapse:collapse">
    ${row("成功 / 失败 tick", `${cs.okTicks} / <span style="color:${cs.fatalTicks > 0 ? "#fbbf24" : "#34d399"}">${cs.fatalTicks}</span>${cs.partialTicks > 0 ? `(另有 ${cs.partialTicks} 次部分成功)` : ""}`)}
    ${row("链上事件 / 已通知 / 官方方向", `${cs.events} / ${cs.notified} / ${cs.directional}`)}
    ${row("永久漏块", `${cs.gapBlocks} 块 ≈ ${gapMinutes} 分钟链上时间`)}
    ${row("最后成功", chainLast ? `${fmtTime(chainLast)}(${ageMinutes(chainLast)} 分钟前)` : '<span style="color:#f87171">无记录</span>')}
  </table>

  <h3 style="margin:14px 0 4px;font-size:14px;color:#7dd3fc">通道二 scan-notify(巡逻,30 分钟)</h3>
  <table style="font-size:13px;border-collapse:collapse">
    ${row("启动 / 完整成功 / Gamma 不可达", `${ss.starts} / ${ss.fullOk} / <span style="color:${ss.gammaUnreachable > 0 ? "#fbbf24" : "#34d399"}">${ss.gammaUnreachable}</span>`)}
    ${row("机会邮件发送次数", String(ss.mailsSent))}
    ${row("最近一次扫描", ss.lastOpportunities != null ? `${ss.lastOpportunities} 个机会,本次新通知 ${ss.lastNotified}` : "本区间无成功扫描")}
    ${row("最后成功", scanLast ? `${fmtTime(scanLast)}(${ageMinutes(scanLast)} 分钟前)` : '<span style="color:#f87171">无记录(或尚未生成标记)</span>')}
  </table>

  <p style="margin:14px 0 0;font-size:12px;color:${hcConfigured ? "#34d399" : "#fbbf24"}">
    ${hcConfigured ? "✅ healthchecks.io 心跳已配置(整机死亡也会被外部告警)。" : "⚠️ healthchecks.io 心跳未配置 — 整机死亡时本日报也会消失且无人报警。注册后把两个 ping URL 填入 ~/prededge/.env 的 HC_PING_CHAIN_WATCH / HC_PING_SCAN_NOTIFY。"}
  </p>
  <p style="margin:8px 0 0;font-size:11px;color:#6b7280">约定:每天 09:05 必有本邮件;没收到 = 系统死了。scripts/heartbeat.ts --daily 自动发送。</p>
</div>`;

  const text = [
    `统计区间 ${periodFrom} → ${fmtTime(now)}`,
    `chain-watch: ok=${cs.okTicks} fatal=${cs.fatalTicks} partial=${cs.partialTicks} events=${cs.events} notified=${cs.notified} directional=${cs.directional} gap=${cs.gapBlocks}`,
    `scan-notify: starts=${ss.starts} fullOk=${ss.fullOk} unreachable=${ss.gammaUnreachable} mails=${ss.mailsSent}`,
    hcConfigured ? "HC ping: configured" : "HC ping: NOT configured",
  ].join("\n");

  await sendMail({ subject, html, text });
  // 发信成功后才推进 offset — 失败则本区间下次日报补上
  state.offsets["chain-watch"] = chainLog.nextOffset;
  state.offsets["scan-notify"] = scanLog.nextOffset;
  if (chainLog.ino != null) state.logInodes["chain-watch"] = chainLog.ino;
  if (scanLog.ino != null) state.logInodes["scan-notify"] = scanLog.ino;
  state.lastDigestAt = now.toISOString();
  saveState(state);
  console.log(JSON.stringify({ mode: "heartbeat-daily", at: now.toISOString(), chain: cs, scan: ss }));
}

// ── 入口 ──

const mode = process.argv.includes("--daily") ? "daily" : "watch";
(mode === "daily" ? daily() : watch()).catch((err) => {
  console.error(`[heartbeat] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
