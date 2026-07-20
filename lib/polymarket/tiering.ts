/**
 * 标题分级(tier)与标签渲染 — 从 chain-watch 抽出的纯函数(审计 §3.4)。
 *
 * 历史地雷:自动下单与 paper 登记闸门曾用 `label.startsWith("🟢")` 判档,而
 * 标签文案 15 个月里改过 5 次以上 —— 任何一次改前缀,执行与登记就静默停摆、
 * 邮件表面全绿。tier 是机器读的结构化档位,label 是人读的展示文案:
 * 闸门只准看 tier,label 随便改。
 *
 * 分级依据 bt4 实测(2026-07-09,v4 全量重放 + 四实验臂):
 *   🟢 只授「双确认 ∧ LLM conf=high」——唯一跨 prompt 稳健结构(四臂交集
 *   17/17 全胜 +524%);medium 区含历史全部 -100% 级灾难,一律降 🟠(M1)。
 *   🟢🔥 肥尾候选 > 🟢 双确认 > 🔄 更正置顶 > 🟠 官方方向 > 🔵 LLM 判读 > ⚪。
 */
import { isDirectionalStance } from "../virtualTags";
import { stancePolarity } from "./execCheck";
import type { LlmStanceVerdict } from "./llmStance";
import type { ExecCheck } from "./execCheck";

export type Tier =
  | "green_fire" // 🟢🔥 肥尾候选(双确认∧high∧深价位/争议中)
  | "green" // 🟢 双确认(含尾价 carry)
  | "correction" // 🔄 更正裁定置顶展示(未过 🟢 闸,不冒充绿档)
  | "orange" // 🟠 官方方向(中置信/红旗/复判分歧/LLM 拒判/边界未决)
  | "blue" // 🔵 LLM 单独判读
  | "degraded" // ⚪ 官方文本读取失败降级
  | "none"; // ⚪ 无方向

export interface TierVerdict {
  rank: number;
  tier: Tier;
  label: string;
}

/** 自动下单 / paper 登记的唯一档位判据(绝不解析 label 文案)。
 * 注意:correction 包装保留过闸 🟢 的 tier(green/green_fire),所以
 * 「🟢∧🔄注解」照常放行 —— 与 2026-07-10 的 P2 语义一致。 */
export const isGreen = (t: Pick<TierVerdict, "tier">): boolean =>
  t.tier === "green" || t.tier === "green_fire";

/** priorityOf 需要的最小事件视图(chain-watch 的 Notable 结构性满足)。 */
export interface TierInput {
  stance: string;
  confidence: string;
  kinds: ReadonlySet<"reset" | "context">;
  enriched: boolean;
  llm?: LlmStanceVerdict | null;
  exec?: ExecCheck | null;
  llmRevoteMismatch?: LlmStanceVerdict;
  correction?: boolean;
  forecastTemplate?: boolean;
}

export interface TierOptions {
  /** I4 规则层边界闸门(LLM_BOUNDARY_GUARD;M6:仅标注语义)。 */
  boundaryGuardOn: boolean;
}

/** fail-closed(2026-07-19 审查 §10,与 tradeExecutor 预告家族闸1 同条件):
 * eventStatus=null 是 llmStance 设计内状态(v3 回复/字段缺失),原 ===
 * "pending" 对 null/unclear 放行。leans ∧ 未确认已决一律按边界未决降档。 */
const boundaryPending = (n: TierInput, opts: TierOptions): boolean =>
  opts.boundaryGuardOn &&
  n.llm != null &&
  n.llm.eventStatus !== "decided" &&
  (/^leans_/i.test(n.llm.stance) || /^leans_/i.test(n.stance));

function basePriorityOf(n: TierInput, opts: TierOptions): TierVerdict {
  const polarity = stancePolarity;
  const llmDir = n.llm != null && isDirectionalStance(n.llm.stance) && n.llm.confidence !== "low";
  // P3 预告模板家族注解(label-only,不降档)。bt5/E3b 的"绿档均值 −5.5%"
  // 经 2026-07-14 官方行为研究修正:负收益只属预告期入场,肉在落地后 20-60s
  // (簇级 meat 中位 9~17pp);执行侧走三闸门制(tradeExecutor §7.2)。
  const forecastBit = n.forecastTemplate ? " ⏰预告模板家族(落地瞬间机会·执行三闸门)" : "";
  if (isDirectionalStance(n.stance)) {
    if (llmDir && polarity(n.llm!.stance) === polarity(n.stance)) {
      if (boundaryPending(n, opts))
        return { rank: 1, tier: "orange", label: `🟠 官方方向 ${n.stance}·${n.confidence} (⚠️边界澄清·事件未决)` };
      // M1:🟢 只授 conf=high。bt4 实测 medium 区 = 历史全部 -100% 所在。
      if (n.llm!.confidence !== "high")
        return { rank: 1, tier: "orange", label: `🟠 官方方向 ${n.stance}·${n.confidence} (双确认·中置信⚠历史灾难区)` };
      const ask = n.exec?.bestAsk ?? null;
      // M2 H2 红旗:极端逆共识(<0.15 逆着 85%+ 共识)∧ LLM 非决断句式 → 不给 🟢。
      if (ask != null && ask < 0.15 && /^leans_/i.test(n.llm!.stance))
        return { rank: 1, tier: "orange", label: `🟠 官方方向 ${n.stance}·${n.confidence} (🚩极端逆共识·历史此形态4/4归零)` };
      // M3:复判分歧 → 降档(反向与失方向分开表述,标签必须如实)。
      if (n.llmRevoteMismatch)
        return {
          rank: 1,
          tier: "orange",
          label: `🟠 官方方向 ${n.stance}·${n.confidence} (${
            isDirectionalStance(n.llmRevoteMismatch.stance) ? "复判反向⚠" : "复判失方向⚠"
          }:二票 ${n.llmRevoteMismatch.stance})`,
        };
      // I3 🟢 内部再分级:深价位(或无盘口但争议中)= 肥尾候选;尾价 ≥0.97 = 薄利 carry。
      if ((ask != null && ask <= 0.9) || (ask == null && n.kinds.has("reset")))
        return { rank: 0, tier: "green_fire", label: `🟢🔥 肥尾候选 ${n.stance}·${n.confidence}${forecastBit}` };
      if (ask != null && ask >= 0.97)
        return { rank: 0, tier: "green", label: `🟢 双确认 ${n.stance}·${n.confidence} (尾价carry)${forecastBit}` };
      return { rank: 0, tier: "green", label: `🟢 双确认 ${n.stance}·${n.confidence}${forecastBit}` };
    }
    if (n.llm && !isDirectionalStance(n.llm.stance))
      return { rank: 1, tier: "orange", label: `🟠 官方方向 ${n.stance}·${n.confidence} (LLM拒判⚠)` };
    return { rank: 1, tier: "orange", label: `🟠 官方方向 ${n.stance}·${n.confidence}` };
  }
  if (llmDir) return { rank: 2, tier: "blue", label: `🔵 LLM判读 ${n.llm!.stance}·${n.llm!.confidence}` };
  if (!n.enriched) return { rank: 3, tier: "degraded", label: `⚪ 降级(文本读取失败)` };
  return { rank: 4, tier: "none", label: `⚪ ${n.stance}` };
}

/** P2(bt5/E2)更正裁定分层语义(2026-07-10 设计复盘后修正):
 *   · 更正 ∧ 独立过双确认∧high 闸 → 保留绿档 tier + 🔄 注解(闸门保真,照常
 *     paper 登记与自动执行);
 *   · 更正但未过闸 → tier=correction 置顶展示专用,不冒充 🟢。 */
export function priorityOf(n: TierInput, opts: TierOptions): TierVerdict {
  const base = basePriorityOf(n, opts);
  if (!n.correction) return base;
  if (isGreen(base)) {
    return { ...base, label: `${base.label} ·🔄更正裁定` };
  }
  const llmDir = n.llm != null && isDirectionalStance(n.llm.stance) && n.llm.confidence !== "low";
  const st = isDirectionalStance(n.stance)
    ? `${n.stance}·${n.confidence}`
    : llmDir
      ? `${n.llm!.stance}·${n.llm!.confidence}(via=llm)`
      : "方向待人工判读⚠";
  return { rank: 0, tier: "correction", label: `🔄 官方更正裁定(issued-in-error) ${st}` };
}

/** 肥尾"形态"(双确认∧深价位/争议中,不含 M1/M2/M3 降档条件):洪水豁免用它
 * 而非 tier —— 降档承诺是 label-only,被降档的肥尾形态若因此改走 6h 汇总,
 * 恰恰在批量裁定日延误了灾难形/机会形并存的关键告警。置信 low 不算。 */
export function isFatTailShape(n: TierInput): boolean {
  if (!isDirectionalStance(n.stance)) return false;
  if (!n.llm || !isDirectionalStance(n.llm.stance) || n.llm.confidence === "low") return false;
  if (stancePolarity(n.llm.stance) !== stancePolarity(n.stance)) return false;
  const ask = n.exec?.bestAsk ?? null;
  return (ask != null && ask <= 0.9) || (ask == null && n.kinds.has("reset"));
}
