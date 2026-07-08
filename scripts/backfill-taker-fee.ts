/**
 * 一次性回填 opportunities.taker_fee_rate(改进 I8,纯数据卫生)。
 *
 * 背景:taker_fee_rate 列是后加的(ensureOpportunityColumns),历史行全 NULL,
 * 只有新扫描行才带真实费率——任何基于历史行的费后核算都会把"未知"当"免费"。
 * 本脚本按 condition_id 去重后从 Gamma 拉 feeSchedule,用与 scanner 相同的
 * takerFeeRateOf 口径(feesEnabled=false→0,true→rate,未知→NULL 保持)回填。
 *
 * Gamma 默认过滤已 closed 的市场(2026-07 backtest 的 lookupMissing 主因),
 * 历史机会大多已 closed,所以 condition_ids 查询做 默认+closed=true 双查合并。
 *
 * 用法: npx tsx scripts/backfill-taker-fee.ts [--dry-run]
 * 幂等:只更新 taker_fee_rate IS NULL 的行,可重复跑。
 */
import { getDb } from "../lib/localDb";
import { takerFeeRateOf } from "../lib/polymarket/scanner";
import { GAMMA_API } from "../lib/polymarket/config";
import type { GammaMarket } from "../lib/types";

const DRY_RUN = process.argv.includes("--dry-run");
const CHUNK = 20;

async function fetchChunk(conditionIds: string[], closed: boolean): Promise<GammaMarket[]> {
  const params = new URLSearchParams();
  for (const id of conditionIds) params.append("condition_ids", id);
  params.set("limit", String(conditionIds.length));
  if (closed) params.set("closed", "true");
  const res = await fetch(`${GAMMA_API}/markets?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as GammaMarket[] | null;
  return Array.isArray(data) ? data : [];
}

async function main(): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT DISTINCT condition_id FROM opportunities WHERE taker_fee_rate IS NULL AND condition_id IS NOT NULL"
    )
    .all() as Array<{ condition_id: string }>;
  const ids = rows.map((r) => r.condition_id).filter(Boolean);
  console.log(`[backfill] taker_fee_rate 为 NULL 的 condition_id: ${ids.length} 个`);
  if (ids.length === 0) return;

  const rateByCid = new Map<string, number>();
  let fetched = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const markets: GammaMarket[] = [];
    for (const closed of [false, true]) {
      try {
        markets.push(...(await fetchChunk(chunk, closed)));
      } catch (err) {
        console.warn(`[backfill] Gamma 查询失败(closed=${closed}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const m of markets) {
      if (!m.conditionId || rateByCid.has(m.conditionId)) continue;
      const rate = takerFeeRateOf(m);
      if (rate != null) rateByCid.set(m.conditionId, rate);
    }
    fetched += chunk.length;
    if (fetched % 200 === 0 || fetched >= ids.length) {
      console.log(`[backfill] 已查 ${fetched}/${ids.length},已解析费率 ${rateByCid.size}`);
    }
  }

  let updated = 0;
  const stmt = db.prepare(
    "UPDATE opportunities SET taker_fee_rate = ? WHERE condition_id = ? AND taker_fee_rate IS NULL"
  );
  for (const [cid, rate] of rateByCid) {
    if (DRY_RUN) {
      updated += 1;
      continue;
    }
    const result = stmt.run(rate, cid);
    updated += Number(result.changes);
  }
  console.log(
    `[backfill] ${DRY_RUN ? "(dry-run) 将" : "已"}回填 ${updated} 行(${rateByCid.size}/${ids.length} 个 condition_id 命中 Gamma);其余保持 NULL(=未知,非免费)。`
  );
}

main().catch((err) => {
  console.error("[backfill] 失败:", err);
  process.exit(1);
});
