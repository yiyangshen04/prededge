/**
 * 邮件发送模块 — scan-notify.ts / send-test-mail.ts 从这里 import。
 *
 * 配置全部来自环境变量(dotenv 依次加载 .env.local、.env;
 * dotenv 默认不覆盖已存在的 process.env 值):
 *
 *   SMTP_HOST       默认 smtp.163.com
 *   SMTP_PORT       默认 465
 *   SMTP_SECURE     默认 true("false"/"0" 视为 false)
 *   MAIL_USER       必填 — SMTP 登录邮箱,同时是 From 地址
 *   MAIL_AUTH_CODE  必填 — SMTP 授权码(不是登录密码)。绝不写入代码/日志。
 *   MAIL_TO         默认 = MAIL_USER
 *   MAIL_FROM_NAME  默认 "PredEdge Scanner"
 *
 * 163 注意:From 地址必须等于 MAIL_USER(登录账号),否则 163 以 554 拒信。
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import nodemailer from "nodemailer";
import type { Opportunity, ScanRun } from "../lib/types";

const PROJECT_ROOT = path.resolve(__dirname, "..");

// .env.local 优先于 .env;两者都不覆盖已有的 process.env 值。
loadEnv({ path: path.join(PROJECT_ROOT, ".env.local"), quiet: true });
loadEnv({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });

// ── 配置 ──

interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** SMTP 授权码 — 只在内存中传给 nodemailer,不打印、不落盘。 */
  authCode: string;
  to: string;
  fromName: string;
}

function loadMailConfig(): MailConfig {
  const user = process.env.MAIL_USER?.trim();
  const authCode = process.env.MAIL_AUTH_CODE?.trim();

  if (!user || !authCode) {
    const missing = [!user && "MAIL_USER", !authCode && "MAIL_AUTH_CODE"]
      .filter(Boolean)
      .join(" 和 ");
    throw new Error(
      `邮件配置缺失: ${missing} 未设置。` +
        `请在项目根目录的 .env.local(或运行环境变量)中配置:` +
        `MAIL_USER=SMTP 登录邮箱,MAIL_AUTH_CODE=该邮箱的 SMTP 授权码` +
        `(163 邮箱在 网页设置 → POP3/SMTP/IMAP 里开启服务并生成授权码,不是登录密码)。` +
        `变量清单见 .env.example。`
    );
  }

  const secureRaw = (process.env.SMTP_SECURE ?? "true").trim().toLowerCase();

  return {
    host: process.env.SMTP_HOST?.trim() || "smtp.163.com",
    port: Number.parseInt(process.env.SMTP_PORT ?? "465", 10) || 465,
    secure: secureRaw !== "false" && secureRaw !== "0",
    user,
    authCode,
    to: process.env.MAIL_TO?.trim() || user,
    fromName: process.env.MAIL_FROM_NAME?.trim() || "PredEdge Scanner",
  };
}

// ── 发送 ──

export interface MailContent {
  subject: string;
  html: string;
  text: string;
}

export async function sendMail({
  subject,
  html,
  text,
}: MailContent): Promise<{ messageId: string }> {
  const cfg = loadMailConfig();

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.authCode },
  });

  const info = await transporter.sendMail({
    // 163 要求 From == 登录账号,display name 随意。
    from: { name: cfg.fromName, address: cfg.user },
    to: cfg.to,
    subject,
    text,
    html,
  });

  return { messageId: info.messageId };
}

// ── 邮件内容渲染 ──

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatLocalMinute(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

function fmtPct(v: number | undefined | null): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(1)}%` : "—";
}

function fmtUsd(v: number | undefined | null): string {
  return typeof v === "number" && Number.isFinite(v)
    ? `$${Math.round(v).toLocaleString("en-US")}`
    : "—";
}

function fmtPrice(v: number | undefined | null): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(3) : "—";
}

function isDivergencePlay(o: Opportunity): boolean {
  return (o.decisionReasons ?? []).includes("official_divergence_play");
}

function badgeHtml(label: string, bg: string, fg: string): string {
  return (
    `<span style="display:inline-block;padding:1px 7px;margin:1px 3px 1px 0;` +
    `border-radius:9px;font-size:11px;background:${bg};color:${fg};white-space:nowrap">` +
    `${escapeHtml(label)}</span>`
  );
}

const DECISION_COLOR: Record<string, string> = {
  actionable: "#34d399",
  observe: "#fbbf24",
  rejected: "#f87171",
};

/** 徽标:reasons 中的关键形态 + officialContext.refundClause。 */
function badgesFor(o: Opportunity): { html: string; text: string[] } {
  const reasons = o.decisionReasons ?? [];
  const html: string[] = [];
  const text: string[] = [];
  if (reasons.includes("official_divergence_play")) {
    html.push(badgeHtml("分歧形态", "#7c2d12", "#fdba74"));
    text.push("official_divergence_play");
  }
  if (reasons.includes("official_direction_backed")) {
    html.push(badgeHtml("官方背书", "#14532d", "#86efac"));
    text.push("official_direction_backed");
  }
  if (reasons.includes("refund_clause") || o.officialContext?.refundClause) {
    html.push(badgeHtml("退款条款", "#450a0a", "#fca5a5"));
    text.push("refund_clause");
  }
  return { html: html.join("") || "—", text };
}

function coverageSummary(scan: ScanRun): string {
  const cov = scan.disputeCoverage;
  if (!cov) return "争议面覆盖: 无数据";
  return cov.complete
    ? `争议面 ${cov.disputedCount}+${cov.replayCount} complete`
    : `争议面 ${cov.disputedCount}+${cov.replayCount} 不完整(部分市场可能缺失)`;
}

/**
 * 渲染"值得通知的机会"邮件(HTML 表格 + 纯文本 fallback)。
 * 分歧形态(official_divergence_play)行以橙色左边框高亮并排在最前。
 */
export function renderOpportunitiesEmail(
  opps: Opportunity[],
  scan: ScanRun
): MailContent {
  // 标题即分诊:最高优先级机会的形态+方向/净收益直接进主题行。
  // 🔴 官方分歧(规则 b,小时级窗口) > 🟠 官方文本背书(规则 c,32/32 口径)
  // > 🟡 纯争议有肉(规则 a,net≥3%)。
  const oppPriority = (o: Opportunity): { rank: number; label: string } => {
    const oc = o.officialContext;
    if (isDivergencePlay(o))
      return { rank: 0, label: `🔴 分歧${oc ? ` ${oc.stance}·${oc.confidence}` : ""}` };
    if ((o.decisionReasons ?? []).includes("official_direction_backed") && oc?.via === "text")
      return { rank: 1, label: `🟠 官方背书 ${oc.stance}·${oc.confidence}` };
    return { rank: 2, label: `🟡 争议 net${((o.netReturnPct ?? 0) * 100).toFixed(1)}%` };
  };
  const sorted = [...opps].sort((a, b) => {
    const d = oppPriority(a).rank - oppPriority(b).rank;
    if (d !== 0) return d;
    return (b.annualizedYieldPct ?? 0) - (a.annualizedYieldPct ?? 0);
  });

  const now = formatLocalMinute();
  const top = sorted[0];
  const subject =
    `[PredEdge] ${oppPriority(top).label} | ${top.question.slice(0, 40)}` +
    (sorted.length > 1 ? ` 等${sorted.length}个` : "") +
    ` — ${now}`;

  const durationSec = Number.isFinite(scan.durationMs)
    ? `${(scan.durationMs / 1000).toFixed(1)}s`
    : "—";
  const cov = scan.disputeCoverage;
  const covHtml = cov
    ? cov.complete
      ? `<span style="color:#34d399">争议面 ${cov.disputedCount}+${cov.replayCount} complete</span>`
      : `<span style="color:#fbbf24">&#9888; 争议面 ${cov.disputedCount}+${cov.replayCount} 不完整 — 部分市场可能缺失</span>`
    : `<span style="color:#9aa3ad">争议面覆盖: 无数据</span>`;

  const th = (label: string) =>
    `<th style="text-align:left;padding:7px 10px;border-bottom:2px solid #3a4048;` +
    `font-size:11px;color:#9aa3ad;font-weight:600;white-space:nowrap">${label}</th>`;

  const rowsHtml = sorted
    .map((o) => {
      const divergence = isDivergencePlay(o);
      const stance = o.officialContext
        ? `${escapeHtml(o.officialContext.stance)} <span style="color:#9aa3ad">(${escapeHtml(
            o.officialContext.confidence
          )})</span>`
        : "—";
      const decisionColor = DECISION_COLOR[o.decision] ?? "#e6e8eb";
      const rowBg = divergence ? "background:#2b2115;" : "";
      const firstTdBorder = divergence
        ? "border-left:4px solid #f59e0b;"
        : "border-left:4px solid transparent;";
      const td = (inner: string, extra = "") =>
        `<td style="padding:8px 10px;border-bottom:1px solid #2a2f36;` +
        `vertical-align:top;${rowBg}${extra}">${inner}</td>`;
      const question = o.marketUrl
        ? `<a href="${escapeHtml(o.marketUrl)}" style="color:#7dd3fc;text-decoration:none">` +
          `${escapeHtml(o.question)}</a>`
        : escapeHtml(o.question);
      const badges = badgesFor(o);
      return (
        `<tr>` +
        td(question, firstTdBorder) +
        td(escapeHtml(o.outcome)) +
        td(fmtPrice(o.price)) +
        td(`<span style="color:${decisionColor};font-weight:600">${escapeHtml(o.decision)}</span>`) +
        td(stance) +
        td(badges.html) +
        td(fmtUsd(o.nearDepthUsd)) +
        td(fmtPct(o.annualizedYieldPct)) +
        `</tr>`
      );
    })
    .join("\n");

  const html = `<div style="background:#14171c;color:#e6e8eb;padding:20px 22px;border-radius:10px;font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;max-width:1000px">
  <h2 style="margin:0 0 4px;font-size:17px;color:#f3f4f6">PredEdge — UMA 争议机会通知</h2>
  <p style="margin:0 0 14px;font-size:12px;color:#9aa3ad">
    scan <span style="color:#c9ced6">${escapeHtml(scan.scanId)}</span>
    &nbsp;·&nbsp; 扫描 ${scan.marketsScanned} 个市场
    &nbsp;·&nbsp; 耗时 ${durationSec}
    &nbsp;·&nbsp; ${covHtml}
  </p>
  <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;font-size:13px">
    <thead>
      <tr>
        ${th("市场")}${th("Outcome")}${th("Price")}${th("Decision")}${th("官方立场")}${th("徽标")}${th("近端深度")}${th("年化")}
      </tr>
    </thead>
    <tbody>
${rowsHtml}
    </tbody>
  </table>
  <p style="margin:14px 0 0;font-size:11px;color:#6b7280">
    橙色左边框 = 官方分歧形态(official_divergence_play,最高优先)。
    本邮件由 PredEdge 无头扫描器自动发送(scripts/scan-notify.ts)。
  </p>
</div>`;

  const textLines: string[] = [
    subject,
    `scan ${scan.scanId} | 扫描 ${scan.marketsScanned} 个市场 | 耗时 ${durationSec} | ${coverageSummary(scan)}`,
    "",
  ];
  sorted.forEach((o, i) => {
    const badges = badgesFor(o);
    const stanceText = o.officialContext
      ? `${o.officialContext.stance} (${o.officialContext.confidence})`
      : "—";
    textLines.push(
      `${i + 1}. ${isDivergencePlay(o) ? "[分歧] " : ""}${o.question}`,
      `   outcome=${o.outcome} price=${fmtPrice(o.price)} decision=${o.decision}`,
      `   官方立场: ${stanceText}${badges.text.length ? ` | ${badges.text.join(", ")}` : ""}`,
      `   近端深度 ${fmtUsd(o.nearDepthUsd)} | 年化 ${fmtPct(o.annualizedYieldPct)}`,
      `   ${o.marketUrl}`,
      ""
    );
  });

  return { subject, html, text: textLines.join("\n") };
}
