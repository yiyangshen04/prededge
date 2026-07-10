/**
 * P0-1 回归(2026-07-10 实盘盈利审计 §2.1):额度求和口径 exposedUsd ——
 * 零成交/明确拒单不占额度,partial 按实际成交,postOrder 超时保守按 requested。
 * 运行:npx tsx --test tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { exposedUsd } from "../lib/polymarket/tradeExecutor";

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
