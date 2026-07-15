/**
 * negRisk 映射回归(2026-07-15 SOOP 九盘缺口):链上 qid(negRiskRequestID)
 * → operator.questionIds → conditionId 推导,与 CLOB 兜底的 GammaMarket 适配。
 * 固定向量全部来自链上/CLOB 实测(见 execCheck.ts 头注)。
 * 运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveNegRiskConditionId,
  clobToGammaMarket,
  NEG_RISK_ADAPTER,
  CTF_SELECTOR,
  QUESTION_IDS_SELECTOR,
} from "../lib/polymarket/execCheck";
import { keccak256 } from "../lib/polymarket/keccak";

const selector = (sig: string): string =>
  `0x${Array.from(keccak256(new TextEncoder().encode(sig)).slice(0, 4))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

test("ethCall 选择子常量与函数签名 keccak 一致", () => {
  assert.equal(CTF_SELECTOR, selector("ctf()"));
  assert.equal(QUESTION_IDS_SELECTOR, selector("questionIds(bytes32)"));
});

test("negRisk conditionId 推导:V3.1 现役市场实测向量", () => {
  // Gamma 三元组(2026-07-15):operator 0x71523d0f….questionIds(0x27905582…)
  // = 该 questionID,Gamma conditionId 与推导一致。
  assert.equal(
    deriveNegRiskConditionId("0xd2c21cbb9d2cb407ab3dcf619d93f6d65b7967154cd6ee930f7758baa2b4bf05"),
    "0x4a8005d19b41af72c1cd5c619640d9d51da548dd7c3544b12ae0c520d9e6805b"
  );
});

test("negRisk conditionId 推导:SOOP LOS(V4 operator 0x661992ae…)实测向量", () => {
  // OP4.questionIds(0xd343600e…) = 0x0f53c828…00,CLOB /markets/<cid> 命中
  // "Will LOS Win the 2026 SOOP Cross Region LoL Invitational"。
  assert.equal(
    deriveNegRiskConditionId("0x0f53c828961045dd9dcf131e0253d673310d8089cbba0cf1b42057f71f540800"),
    "0x291fcb9ad3b42f6abcb257ebcc0a49010ae7f5d6b180e466127a0c232668860c"
  );
});

test("NegRiskAdapter 地址固定(V3.1/V4 两家 operator 的 nrAdapter 实测同值)", () => {
  assert.equal(NEG_RISK_ADAPTER, "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296");
});

// SOOP LOS 的 CLOB 响应关键字段(2026-07-15 实测):closed=false 但
// archived=true、book 关闭 —— closed 语义必须收紧为"不可交易",否则
// maybeExecuteTrade 会对下架市场走 executeSignal。
const LOS_CLOB = {
  condition_id: "0x291fcb9ad3b42f6abcb257ebcc0a49010ae7f5d6b180e466127a0c232668860c",
  question: "Will LOS Win the 2026 SOOP Cross Region LoL Invitational",
  market_slug: "will-los-win-the-2026-soop-cross-region-lol-invitational-20260624191454927",
  end_date_iso: null,
  active: false,
  closed: false,
  archived: true,
  enable_order_book: false,
  neg_risk: true,
  tokens: [
    { token_id: "89703597153143779370114105536395342990560547017539330634769066308823091489266", outcome: "Yes" },
    { token_id: "110250917892290937783569351931696087452945221310409313880456010762554720518636", outcome: "No" },
  ],
};

test("clobToGammaMarket:归档市场 closed 收紧为 true,tokens 映射为 JSON 字符串", () => {
  const m = clobToGammaMarket(LOS_CLOB);
  assert.ok(m);
  assert.equal(m.closed, true); // archived ∧ book 关闭 → 不可交易
  assert.equal(m.conditionId, LOS_CLOB.condition_id);
  assert.equal(m.negRisk, true);
  assert.deepEqual(JSON.parse(m.outcomes), ["Yes", "No"]);
  assert.deepEqual(JSON.parse(m.clobTokenIds), [LOS_CLOB.tokens[0].token_id, LOS_CLOB.tokens[1].token_id]);
});

test("clobToGammaMarket:在市可交易盘 closed=false;缺 tokens → null", () => {
  const live = clobToGammaMarket({
    ...LOS_CLOB,
    active: true,
    archived: false,
    enable_order_book: true,
  });
  assert.ok(live);
  assert.equal(live.closed, false);
  assert.equal(clobToGammaMarket({ ...LOS_CLOB, tokens: [] }), null);
  assert.equal(
    clobToGammaMarket({ ...LOS_CLOB, tokens: [{ token_id: "", outcome: "Yes" }] }),
    null
  );
});
