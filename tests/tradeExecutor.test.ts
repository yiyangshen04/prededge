/**
 * P0-1 回归(2026-07-10 实盘盈利审计 §2.1):额度求和口径 exposedUsd ——
 * 零成交/明确拒单不占额度,partial 按实际成交,postOrder 超时保守按 requested。
 * 运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exposedUsd,
  upDriftBand,
  crashDropThreshold,
  findOppositeLeg,
  consecutiveLossTail,
  computeSettlementPnl,
  collapseAttempts,
  isTransportAmbiguous,
  lossHaltTripped,
  settledFinal,
} from "../lib/polymarket/tradeExecutor";

test("filled/partial 按 filledUsd 计,而非 requestedUsd", () => {
  assert.equal(exposedUsd({ mode: "live", posted: true, requestedUsd: 100, filledUsd: 97.5 }), 97.5);
  assert.equal(exposedUsd({ mode: "live", posted: true, requestedUsd: 100, filledUsd: 37 }), 37);
});

test("FAK 零成交与 CLOB 明确拒单(posted=true 但无成交)不占额度", () => {
  // 修复前:posted=true 即按 requestedUsd 终身累计,8 次零成交尝试就打满 $800
  assert.equal(exposedUsd({ mode: "live", posted: true, requestedUsd: 100 }), 0);
});

test("postOrder 超时(posted=unknown,交易所可能已受理)保守按 requestedUsd", () => {
  assert.equal(exposedUsd({ mode: "live", posted: "unknown", requestedUsd: 100 }), 100);
});

test("未发出(posted=false)、dry、probe 一律不占额度", () => {
  assert.equal(exposedUsd({ mode: "live", posted: false, requestedUsd: 100 }), 0);
  assert.equal(exposedUsd({ mode: "dry", posted: false, requestedUsd: 100 }), 0);
  assert.equal(exposedUsd({ mode: "live", probe: true, posted: true, requestedUsd: 1, filledUsd: 1 }), 0);
});

// ── §2.3 漂移带形状(2026-07-11)──

test("上行漂移带按剩余边缩放:低价位放宽(Norway 0.164→0.20 放行),高价位不变", () => {
  // 0.164:带宽 = max(0.03, 0.15×0.836) ≈ 0.125 → 0.20 在带内(旧绝对带 0.03 会拒单)
  const band = upDriftBand(0.164, 0.03, 0.15);
  assert.ok(0.2 <= 0.164 + band, `0.20 应在带内(band=${band})`);
  // 0.90:退化回绝对带,不收紧既有行为
  assert.equal(upDriftBand(0.9, 0.03, 0.15), 0.03);
});

test("下行暴跌阈值:高价位按比例,极低价位不低于绝对滑点", () => {
  assert.ok(Math.abs(crashDropThreshold(0.9, 0.03, 0.35) - 0.315) < 1e-9);
  assert.equal(crashDropThreshold(0.05, 0.03, 0.35), 0.03);
});

// ── §7 翻向双腿保护 ──

test("findOppositeLeg:同 conditionId 不同 tokenId 且有敞口才算冲突", () => {
  const held = { conditionId: "0xc1", tokenId: "A", mode: "live" as const, posted: true as const, filledUsd: 50, requestedUsd: 50 };
  assert.ok(findOppositeLeg([held], "0xc1", "B"));
  assert.equal(findOppositeLeg([held], "0xc1", "A"), undefined); // 同 token 走 dedup,不算翻向
  assert.equal(findOppositeLeg([held], "0xc2", "B"), undefined); // 不同市场
  assert.equal(findOppositeLeg([held], undefined, "B"), undefined);
  // 零成交(无敞口)不封锁翻向
  const noFill = { ...held, filledUsd: undefined };
  assert.equal(findOppositeLeg([noFill], "0xc1", "B"), undefined);
});

// ── P0-4 结算对账 ──

test("computeSettlementPnl:赢单/输单按结算价核算,outcome 不匹配宁缺毋错", () => {
  const win = computeSettlementPnl([{ outcome: "Yes", filledUsd: 90, filledShares: 100 }], ["Yes", "No"], [1, 0]);
  assert.equal(win?.pnlUsd, 10);
  assert.equal(win?.won, true);
  const loss = computeSettlementPnl([{ outcome: "No", filledUsd: 90, filledShares: 100 }], ["Yes", "No"], [1, 0]);
  assert.equal(loss?.pnlUsd, -90);
  assert.equal(loss?.won, false);
  assert.equal(computeSettlementPnl([{ outcome: "Bruno", filledUsd: 90, filledShares: 100 }], ["Yes", "No"], [1, 0]), null);
  assert.equal(computeSettlementPnl([{ outcome: "Yes" }], ["Yes", "No"], [1, 0]), null); // 无成交明细
});

test("consecutiveLossTail:尾部连亏计数,赢单断链,盈亏未知跳过不断链", () => {
  const rec = (at: string, pnl?: number) => ({ at, pnlUsd: pnl });
  assert.equal(consecutiveLossTail([rec("1", -10), rec("2", -20), rec("3", -30)]), 3);
  assert.equal(consecutiveLossTail([rec("1", -10), rec("2", 5), rec("3", -30)]), 1);
  assert.equal(consecutiveLossTail([rec("1", -10), rec("2"), rec("3", -30)]), 2);
  assert.equal(consecutiveLossTail([rec("1", 5)]), 0);
  assert.equal(consecutiveLossTail([]), 0);
});

// ── 2026-07-11 审计修复批 ──

test("collapseAttempts:终态行取代同 attemptId 的 intent 行,孤儿 intent 保留", () => {
  const intent = { attemptId: "a1", status: "intent", posted: "unknown" as const, requestedUsd: 50 };
  const final_ = { attemptId: "a1", status: "filled", posted: true as const, filledUsd: 48 };
  const orphan = { attemptId: "a2", status: "intent", posted: "unknown" as const, requestedUsd: 30 };
  const legacy = { attemptId: undefined, status: "filled", posted: true as const, filledUsd: 10 }; // 无 attemptId 的历史行
  const out = collapseAttempts([intent, final_, orphan, legacy]);
  assert.deepEqual(out, [final_, orphan, legacy]);
  // 孤儿 intent(进程死在 postOrder 在途窗口)保守占额
  assert.equal(exposedUsd({ mode: "live", posted: "unknown", requestedUsd: 30 }), 30);
});

test("isTransportAmbiguous:{error} 无 status/orderID = 传输层歧义;真拒单带 status 不算", () => {
  assert.equal(isTransportAmbiguous({ error: "socket hang up" }, false), true);
  assert.equal(isTransportAmbiguous({ error: "FAK order ...", status: 400, orderID: "0x1" }, false), false);
  assert.equal(isTransportAmbiguous({ error: "x", status: 502 }, false), false);
  assert.equal(isTransportAmbiguous({ error: "x", orderID: "0x1" }, false), false);
  assert.equal(isTransportAmbiguous({}, false), false);
  assert.equal(isTransportAmbiguous({ error: "x" }, true), false); // 有成交就不是歧义
  assert.equal(isTransportAmbiguous(null, false), false);
});

test("settledFinal:legacy 字符串/带 pnl/pnlUnavailable 为终局;冻结的无 pnl 对象要重探", () => {
  assert.equal(settledFinal("2026-07-01T00:00:00Z"), true);
  assert.equal(settledFinal({ at: "1", pnlUsd: -50 }), true);
  assert.equal(settledFinal({ at: "1", pnlUsd: 0 }), true); // pnl=0 也是终局
  assert.equal(settledFinal({ at: "1", pnlUnavailable: true }), true);
  assert.equal(settledFinal({ at: "1", notified: false }), false); // 修复前冻结的未定型记录
  assert.equal(settledFinal(undefined), false);
});

test("lossHaltTripped:尾亏达阈值触发;水位之后无新亏损不重复熔断", () => {
  const cache = {
    c1: { at: "2026-07-01", pnlUsd: -10 },
    c2: { at: "2026-07-02", pnlUsd: -20 },
    c3: { at: "2026-07-03", pnlUsd: -30 },
  };
  assert.deepEqual(lossHaltTripped(cache, 3), { losses: 3, tripped: true });
  assert.deepEqual(lossHaltTripped(cache, 4), { losses: 3, tripped: false });
  // 已熔断过(水位晚于最后一笔盈亏):删 halt 恢复后不被同一段历史再次熔断
  assert.equal(lossHaltTripped({ ...cache, _lossHaltAt: "2026-07-04" }, 3).tripped, false);
  // 水位后有新亏损落地:再次熔断
  assert.equal(
    lossHaltTripped({ ...cache, _lossHaltAt: "2026-07-02T12:00", c3: { at: "2026-07-03", pnlUsd: -30 } }, 3).tripped,
    true
  );
  // 盈亏未知的记录不稀释计数(consecutiveLossTail 语义透传)
  assert.equal(lossHaltTripped({ ...cache, c4: { at: "2026-07-04", notified: false } }, 3).tripped, true);
});
