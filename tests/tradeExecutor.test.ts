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
