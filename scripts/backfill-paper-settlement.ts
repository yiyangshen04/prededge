/**
 * 一次性回补存量 paper 单结算(2026-07-19 审查 §1 修复配套)。
 *
 * 背景:client.fetchMarketsByConditionIds 修复前每 chunk 只发默认查询,而
 * Gamma 的 condition_ids= 默认查询对已 closed 市场返回空 —— scan-notify 的
 * resolveOpenPaperTrades 对已结算市场从未真正命中过,status=open 的存量
 * paper 单在市场结算后仍终身挂着。修复(双查询合并)后,本脚本按与
 * resolveOpenPaperTrades 完全相同的口径(赢 = shares − 本金 − taker费/转账
 * 成本,输 = −本金;closed 但结算价未定型的跳过)把已可判定的存量单一次性
 * 关掉。幂等:只处理 status=open 行,可重复跑。
 *
 * 用法: npx tsx scripts/backfill-paper-settlement.ts [--dry-run]
 */
import { DEFAULT_SCAN_CONFIG } from "../lib/polymarket/config";
import { PolymarketClient } from "../lib/polymarket/client";
import { takerFeeRateOf } from "../lib/polymarket/scanner";
import { takerFeePct } from "../lib/polymarket/scoring";
import * as db from "../lib/localDb";

const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const open = db.listOpenPaperTrades();
  console.log(`[backfill-paper] status=open 的 paper 单: ${open.length} 笔`);
  if (open.length === 0) return;

  const client = new PolymarketClient(DEFAULT_SCAN_CONFIG);
  const conditionIds = Array.from(new Set(open.map((t) => t.conditionId).filter(Boolean)));
  const marketMap = await client.fetchMarketsByConditionIds(conditionIds);
  console.log(`[backfill-paper] Gamma 命中 ${marketMap.size}/${conditionIds.length} 个 conditionId`);

  let resolved = 0;
  let notClosed = 0;
  let priceNotFinal = 0;
  for (const trade of open) {
    const market = marketMap.get(trade.conditionId);
    if (!market || !market.closed) {
      notClosed += 1;
      continue;
    }
    let outcomes: string[] = [];
    let prices: number[] = [];
    try {
      outcomes = JSON.parse(market.outcomes).map(String);
      prices = JSON.parse(market.outcomePrices).map(Number);
    } catch {
      continue;
    }
    const winnerIdx = prices.findIndex((p) => Number.isFinite(p) && p >= 0.99);
    if (winnerIdx === -1) {
      priceNotFinal += 1; // closed 但 UMA 结算未完 — 留给 scan-notify 下轮
      continue;
    }
    const resolvedOutcome = outcomes[winnerIdx] ?? null;
    let status: "won" | "lost";
    let pnlUsd: number;
    if (resolvedOutcome === trade.outcomeBought) {
      status = "won";
      const avgPrice = trade.shares > 0 ? trade.usdAmount / trade.shares : 0;
      const feeCost =
        trade.usdAmount *
        (takerFeePct(avgPrice, takerFeeRateOf(market), DEFAULT_SCAN_CONFIG) +
          DEFAULT_SCAN_CONFIG.transferCostPct);
      pnlUsd = trade.shares - trade.usdAmount - feeCost;
    } else {
      status = "lost";
      pnlUsd = -trade.usdAmount;
    }
    console.log(
      `[backfill-paper] ${DRY_RUN ? "(dry-run) " : ""}${status.toUpperCase()} ${trade.marketQuestion.slice(0, 60)} | 买 ${trade.outcomeBought} $${trade.usdAmount.toFixed(2)} → 结算 ${resolvedOutcome} | pnl ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)} | 登记于 ${trade.createdAt.slice(0, 10)}`
    );
    if (DRY_RUN) {
      resolved += 1;
      continue;
    }
    const ok = db.updatePaperTradeResolution(trade.id, {
      status,
      resolvedOutcome,
      pnlUsd,
      pnlPct: trade.usdAmount > 0 ? pnlUsd / trade.usdAmount : 0,
      resolvedAt: new Date().toISOString(),
    });
    if (ok) resolved += 1;
  }
  console.log(
    `[backfill-paper] ${DRY_RUN ? "(dry-run) 将" : "已"}关单 ${resolved}/${open.length};市场未关 ${notClosed},closed 但结算价未定型 ${priceNotFinal}(留给 scan-notify 下轮)。`
  );
}

main().catch((err) => {
  console.error("[backfill-paper] 失败:", err);
  process.exit(1);
});
