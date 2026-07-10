/**
 * §3.4 回归(2026-07-11):闸门只准看结构化 tier,label 文案随便改。
 * 这里锁死 tier 语义 —— 任何人改 label 前缀/文案,这些测试必须仍然全绿;
 * 反过来,谁把闸门改回解析 label,isGreen 的契约测试会先失守。
 * 运行:npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { priorityOf, isGreen, isFatTailShape, type TierInput } from "../lib/polymarket/tiering";
import type { ExecCheck } from "../lib/polymarket/execCheck";
import type { LlmStanceVerdict } from "../lib/polymarket/llmStance";

const OPTS = { boundaryGuardOn: true };
const llm = (over: Partial<LlmStanceVerdict> = {}): LlmStanceVerdict => ({
  stance: "YES",
  confidence: "high",
  evidence: "quoted",
  reasoning: null,
  eventStatus: "decided",
  via: "llm",
  ...over,
});
const exec = (bestAsk: number | null): ExecCheck => ({ bestAsk }) as ExecCheck;
const input = (over: Partial<TierInput> = {}): TierInput => ({
  stance: "YES",
  confidence: "high",
  kinds: new Set<"reset" | "context">(["context"]),
  enriched: true,
  llm: llm(),
  exec: exec(0.5),
  ...over,
});

test("双确认∧high∧深价位 → green_fire,isGreen 放行", () => {
  const pr = priorityOf(input(), OPTS);
  assert.equal(pr.tier, "green_fire");
  assert.equal(pr.rank, 0);
  assert.ok(isGreen(pr));
});

test("双确认∧high 中间价与尾价 carry 都是 green(同一 tier,不看 label 文案)", () => {
  assert.equal(priorityOf(input({ exec: exec(0.95) }), OPTS).tier, "green");
  const carry = priorityOf(input({ exec: exec(0.98) }), OPTS);
  assert.equal(carry.tier, "green");
  assert.ok(isGreen(carry));
});

test("M1:LLM medium 置信 → orange,闸门拒绝", () => {
  const pr = priorityOf(input({ llm: llm({ confidence: "medium" }) }), OPTS);
  assert.equal(pr.tier, "orange");
  assert.equal(isGreen(pr), false);
});

test("M2 红旗:ask<0.15 ∧ leans_* → orange", () => {
  const pr = priorityOf(
    input({ stance: "leans_YES", llm: llm({ stance: "leans_YES" }), exec: exec(0.1) }),
    OPTS
  );
  assert.equal(pr.tier, "orange");
});

test("M3:复判分歧 → orange", () => {
  const pr = priorityOf(input({ llmRevoteMismatch: llm({ stance: "NO" }) }), OPTS);
  assert.equal(pr.tier, "orange");
});

test("I4 边界闸门:pending∧leans_* 仅在 guard on 时降档", () => {
  const n = input({ stance: "leans_YES", llm: llm({ stance: "leans_YES", eventStatus: "pending" }) });
  assert.equal(priorityOf(n, { boundaryGuardOn: true }).tier, "orange");
  assert.equal(priorityOf(n, { boundaryGuardOn: false }).tier, "green_fire");
});

test("P2 更正:过闸保留绿档 tier(带🔄注解),未过闸是 correction 展示档", () => {
  const green = priorityOf(input({ correction: true }), OPTS);
  assert.equal(green.tier, "green_fire");
  assert.ok(isGreen(green));
  assert.ok(green.label.includes("🔄"));
  const notGreen = priorityOf(input({ correction: true, llm: llm({ confidence: "medium" }) }), OPTS);
  assert.equal(notGreen.tier, "correction");
  assert.equal(notGreen.rank, 0); // 置顶展示
  assert.equal(isGreen(notGreen), false);
});

test("isGreen 只看 tier 字段 —— label 被改成任何文案都不影响闸门", () => {
  const pr = priorityOf(input(), OPTS);
  pr.label = "【新文案】fat-tail candidate!";
  assert.ok(isGreen(pr));
});

test("isFatTailShape:降档(复判分歧)不影响形态判定(洪水豁免语义)", () => {
  const n = input({ llmRevoteMismatch: llm({ stance: "NO" }) });
  assert.equal(priorityOf(n, OPTS).tier, "orange");
  assert.ok(isFatTailShape(n)); // 形态仍在:双确认∧深价位
  assert.equal(isFatTailShape(input({ llm: llm({ confidence: "low" }) })), false);
});

test("无 LLM 的正则方向 → orange;纯 LLM 方向 → blue;降级 → degraded", () => {
  assert.equal(priorityOf(input({ llm: undefined }), OPTS).tier, "orange");
  assert.equal(priorityOf(input({ stance: "none" }), OPTS).tier, "blue");
  assert.equal(
    priorityOf(input({ stance: "none", llm: undefined, enriched: false }), OPTS).tier,
    "degraded"
  );
});
