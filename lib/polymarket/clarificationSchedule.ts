/**
 * bt5(2026-07-10 标记点调研)的文本结构识别:官方澄清里的时间承诺与更正。
 *
 * P1 定时澄清惯例 —— 官方标准模板:
 *   "If a clarification is to be issued, it will be at 1:00 PM ET on June 1.
 *    If no statement is issued at that time, then there will be no
 *    clarification from the Polymarket Team."
 * 覆盖 80/910 市场(8.8%),承诺提前量中位 1.55h,实际裁定落在承诺时点中位
 * +31 秒(79/80 兑现)。解析出承诺时点 → chain-watch 预埋窗口内快轮询。
 *
 * P2 更正裁定 —— "The previous clarification was made in error." 是 15 个月
 * 里全部 6 例真方向翻转的统一形态(2025-11-17/18 CS 事故簇):更正落地时市场
 * 往往仍锚旧裁定价,是显式的错价窗口。
 *
 * P3 预告模板负向注解 —— green∧预告模板家族 n=13 均 −5.5% 且零肥尾(含全部
 * −110% 级爆仓);green∧非预告 n=37 均 +47%(含全部肥尾)。检测结果只作标注。
 */

/** 模板锚句。官方措辞在 issued/made、from/by the Polymarket [Tt]eam 上有微变
 * 体,但 "if a clarification is to be issued" 与后半句 "if no statement is
 * issued at that time" 二者至少其一在全部 80 个样本中出现。 */
const TEMPLATE_ANCHOR =
  /if (?:a|any) (?:further |additional )?(?:clarification|statement|update) is to be (?:issued|made|posted|provided)/i;
const TEMPLATE_TAIL = /if no (?:statement|clarification|update) is issued at that time/i;

/** 锚句后的承诺时点:"it will be at 1:00 PM ET on June 1"。要求 am/pm 与
 * ET 时区字样(全部样本如此)——宽松解析宁缺勿错,解析失败只是不预埋。 */
const TIME_RE =
  /it will be (?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\s*(?:ET|EST|EDT|Eastern(?:\s+(?:Time|Standard Time|Daylight Time))?)\b/i;
const DATE_RE =
  /\bon\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i;

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/** 承诺时点相对预告文本的合法窗口:早于文本 24h(时钟漂移/同 tick 重读容差)
 * 或晚于 14 天的解析结果一律视为误解析丢弃(实测提前量中位 1.55h)。 */
const MAX_LEAD_MS = 14 * 24 * 3600_000;
const MAX_LAG_MS = 24 * 3600_000;

/** ET(America/New_York)墙钟时刻 → UTC epoch-ms,DST 安全:对 EDT/EST 两个
 * 候选偏移做 Intl 往返校验,取墙钟一致者。春季跳变中不存在的时刻返回 null。 */
export function etWallclockToUtcMs(
  year: number,
  month0: number,
  day: number,
  hour: number,
  minute: number
): number | null {
  // 日期归一化:调用方会传 day+1(无日期分支的"次日"),月末溢出(June 31)靠
  // Date.UTC 的自然进位滚到下月,否则 Intl 往返校验永不匹配 → 合法承诺漏预埋。
  {
    const norm = new Date(Date.UTC(year, month0, day));
    year = norm.getUTCFullYear();
    month0 = norm.getUTCMonth();
    day = norm.getUTCDate();
  }
  for (const offsetHours of [4, 5]) {
    const candidate = Date.UTC(year, month0, day, hour + offsetHours, minute);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(new Date(candidate));
    const num = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    if (
      num("year") === year &&
      num("month") === month0 + 1 &&
      num("day") === day &&
      num("hour") === hour &&
      num("minute") === minute
    ) {
      return candidate;
    }
  }
  return null;
}

/** 当前时刻在 ET 日历下的 (year, month0, day)。 */
function etCalendarDate(epochMs: number): { year: number; month0: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(epochMs));
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: num("year"), month0: num("month") - 1, day: num("day") };
}

export interface ScheduledClarification {
  /** 官方承诺的澄清时点(UTC epoch-ms)。 */
  commitAtMs: number;
  /** 模板原文摘录(锚句起 ~220 字符),邮件展示与人工核对用。 */
  quote: string;
}

/** 判定文本是否属于预告模板家族(P3 负向注解口径,与 bt5/E3b 一致)。 */
export function matchesScheduledClarificationTemplate(text: string | null | undefined): boolean {
  if (!text) return false;
  return TEMPLATE_ANCHOR.test(text) || TEMPLATE_TAIL.test(text);
}

/**
 * 从官方文本解析定时澄清承诺(P1)。updateTsMs = 该条官方文本的链上时间戳,
 * 用于补全年份与合法性窗口校验。解析不出、或时点落在合法窗口外 → null。
 */
export function parseScheduledClarification(
  text: string | null | undefined,
  updateTsMs: number
): ScheduledClarification | null {
  if (!text || !Number.isFinite(updateTsMs) || updateTsMs <= 0) return null;
  const anchorMatch = TEMPLATE_ANCHOR.exec(text);
  if (!anchorMatch) return null;
  // 时点与日期都必须出现在锚句附近,防止把市场规则正文里无关的时间抓进来。
  const windowText = text.slice(anchorMatch.index, anchorMatch.index + 260);
  const timeMatch = TIME_RE.exec(windowText);
  if (!timeMatch) return null;

  let hour = Number(timeMatch[1]);
  const minute = timeMatch[2] != null ? Number(timeMatch[2]) : 0;
  if (!Number.isFinite(hour) || hour < 1 || hour > 12) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
  const isPm = /^p/i.test(timeMatch[3]);
  if (isPm && hour !== 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;

  const dateMatch = DATE_RE.exec(windowText);
  const candidates: number[] = [];
  if (dateMatch) {
    const month0 = MONTHS[dateMatch[1].toLowerCase()];
    const day = Number(dateMatch[2]);
    if (month0 == null || !Number.isFinite(day) || day < 1 || day > 31) return null;
    if (dateMatch[3]) {
      const y = Number(dateMatch[3]);
      const t = etWallclockToUtcMs(y, month0, day, hour, minute);
      if (t != null) candidates.push(t);
    } else {
      // 年份未写(全部样本如此):以文本时间戳的 ET 年为中心试三个年份,
      // 取离文本时点最近者(跨年边界如 12 月底预告 1 月初)。
      const baseYear = etCalendarDate(updateTsMs).year;
      for (const y of [baseYear - 1, baseYear, baseYear + 1]) {
        const t = etWallclockToUtcMs(y, month0, day, hour, minute);
        if (t != null) candidates.push(t);
      }
    }
  } else {
    // 无显式日期:按文本时点的 ET 当日解释;若由此得出的时刻早于文本 2h 以上,
    // 官方语义只可能指次日。
    const { year, month0, day } = etCalendarDate(updateTsMs);
    const sameDay = etWallclockToUtcMs(year, month0, day, hour, minute);
    if (sameDay != null) {
      if (sameDay >= updateTsMs - 2 * 3600_000) {
        candidates.push(sameDay);
      } else {
        const nextDay = etWallclockToUtcMs(year, month0, day + 1, hour, minute);
        if (nextDay != null) candidates.push(nextDay);
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.abs(a - updateTsMs) - Math.abs(b - updateTsMs));
  const commitAtMs = candidates[0];
  if (commitAtMs < updateTsMs - MAX_LAG_MS || commitAtMs > updateTsMs + MAX_LEAD_MS) return null;
  return { commitAtMs, quote: text.slice(anchorMatch.index, anchorMatch.index + 220).trim() };
}

/** P2:最新官方文本是否为 "previous clarification was made/issued in error"
 * 型更正。两个模式都锚定澄清类名词,避免市场正文里无关的 "in error" 误触。 */
const CORRECTION_RES = [
  /\b(?:previous|prior|earlier)\s+(?:clarification|update|statement|resolution|ruling)\b[^.]{0,120}?\bin error\b/i,
  /\b(?:clarification|update|statement|resolution|ruling)\b[^.]{0,120}?\b(?:issued|made|posted)\s+in error\b/i,
];

export function detectCorrection(text: string | null | undefined): boolean {
  if (!text) return false;
  return CORRECTION_RES.some((re) => re.test(text));
}
