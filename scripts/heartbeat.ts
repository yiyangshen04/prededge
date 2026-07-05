/**
 * 心跳监控 + 日报 — cron 入口(只读本地文件,除发信外不碰网络)。
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
 * 注意:本机(sufe)整机死亡时本脚本同样死亡 —— 这层只报"进程还在但坏了";
 * "整机被清"必须靠外部 healthchecks.io(见 run-cron.sh 的 HC_PING_*)。
 */
import fs from "node:fs";
import path from "node:path";
import { sendMail } from "./mailer";

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
  lastDigestAt: string | null;
}

function loadState(): HeartbeatState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      alert: raw.alert && typeof raw.alert === "object" ? raw.alert : {},
      offsets: raw.offsets && typeof raw.offsets === "object" ? raw.offsets : {},
      lastDigestAt: typeof raw.lastDigestAt === "string" ? raw.lastDigestAt : null,
    };
  } catch {
    return { alert: {}, offsets: {}, lastDigestAt: null };
  }
}

function saveState(state: HeartbeatState): void {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1) + "\n", "utf8");
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

// ── watch 模式:超龄告警 / 恢复通知 ──

async function watch(): Promise<void> {
  const state = loadState();
  const events: Array<{ ch: Channel; kind: "down" | "recovered"; detail: string }> = [];
  const summary: Record<string, string> = {};

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

/** 从上次 offset 读新增日志;文件被周日截断(offset > size)时从头重读。 */
function readNewLog(file: string, offset: number): { content: string; nextOffset: number } {
  try {
    const size = fs.statSync(file).size;
    const from = offset > size ? 0 : offset;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, size - from, from);
    fs.closeSync(fd);
    return { content: buf.toString("utf8"), nextOffset: size };
  } catch {
    return { content: "", nextOffset: 0 };
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

  const chainLog = readNewLog(CHANNELS[0].log, state.offsets["chain-watch"] ?? 0);
  const scanLog = readNewLog(CHANNELS[1].log, state.offsets["scan-notify"] ?? 0);
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
