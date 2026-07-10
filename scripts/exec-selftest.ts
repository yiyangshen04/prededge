/**
 * 自动下单链路体检(部署后在生产盒子上跑;本机开发亦可)。
 *
 * 默认(无参):全程只读 —— 钱包→L2 creds→sigType=3 余额/授权→选一个活跃
 * 市场→读盘口。不构造、不签名、不提交任何订单。
 *
 * --dry-exec  强制以 EXEC_MODE=dry 走一遍 executeSignal 完整路径(风控闸→
 *             新鲜盘口→构单+签名,不 postOrder)。ledger 记录带 probe 标记,
 *             不参与去重与额度累计。
 *
 * --probe     发一笔真实探针单:$1 FAK 买单、限价 0.01、只选 bestAsk ≥ 0.05
 *             的市场 —— FAK 只吃 ≤限价的卖单,故必然 0 成交即撤,费用为零。
 *             这是 postOrder 这最后一环的端到端验证(auth/maker 绑定/签名/
 *             订单校验全部过交易所)。
 *
 * Run: npx tsx scripts/exec-selftest.ts [--dry-exec] [--probe]
 */
import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import { execConfig, executionMode, executeSignal, getExecClient } from "../lib/polymarket/tradeExecutor";

const args = new Set(process.argv.slice(2));
const ok = (label: string, detail: string) => console.log(`✅ ${label}: ${detail}`);
const bad = (label: string, detail: string) => console.log(`❌ ${label}: ${detail}`);

async function main(): Promise<void> {
  const cfg = execConfig();
  console.log(
    `配置: EXEC_MODE=${executionMode()} 单笔$${cfg.maxOrderUsd} 日$${cfg.dailyMaxUsd} 总$${cfg.totalMaxUsd} 价格带[${cfg.minPrice},${cfg.maxPrice}] 滑点${cfg.slippage}\n` +
      `      钱包=${cfg.walletJson} creds=${cfg.credsJson}\n` +
      `      kill-switch=${cfg.haltFile} ledger=${cfg.ledger}\n`
  );

  // 1. client(钱包+creds 派生/缓存+三元组)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  try {
    client = await getExecClient();
    ok("client 初始化", "钱包已加载,L2 creds 就绪(派生或缓存)");
  } catch (err) {
    bad("client 初始化", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 2. sigType=3 下 CLOB 视角的余额/授权
  try {
    const { AssetType } = await import("@polymarket/clob-client-v2");
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const ba = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const bal = Number(ba?.balance ?? 0) / 1e6;
    const allow = Math.max(...Object.values(ba?.allowances ?? { x: 0 }).map(Number));
    (bal > 0 ? ok : bad)(
      "CLOB 余额@POLY_1271",
      `balance=$${bal.toFixed(2)} allowance=${allow > 1e30 ? "无限" : `$${(allow / 1e6).toFixed(2)}`}`
    );
  } catch (err) {
    bad("CLOB 余额@POLY_1271", err instanceof Error ? err.message : String(err));
  }

  // 3. 市场发现 + 盘口(公共接口;也验证盒子的代理路径)
  let tokenId: string | null = null;
  let outcome = "?";
  let bestAsk: number | null = null;
  try {
    const sampling = await client.getSamplingSimplifiedMarkets();
    const mkts = (sampling?.data ?? []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (m: any) => m.tokens?.length === 2 && m.tokens.every((t: any) => t.token_id)
    );
    for (const m of mkts) {
      const t = m.tokens[0];
      const book = await client.getOrderBook(String(t.token_id));
      const asks = (book.asks ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((l: any) => Number(l.price))
        .filter((p: number) => Number.isFinite(p))
        .sort((a: number, b: number) => a - b);
      if (asks.length > 0 && asks[0] >= 0.05 && asks[0] <= 0.9) {
        tokenId = String(t.token_id);
        outcome = String(t.outcome ?? "?");
        bestAsk = asks[0];
        break;
      }
    }
    if (tokenId) ok("市场+盘口", `token=${tokenId.slice(0, 12)}… outcome=${outcome} bestAsk=${bestAsk}`);
    else bad("市场+盘口", "sampling 市场里没找到 bestAsk∈[0.05,0.9] 的盘口");
  } catch (err) {
    bad("市场+盘口", err instanceof Error ? err.message : String(err));
  }

  // 4. --dry-exec:executeSignal 全路径演练(不提交)
  if (args.has("--dry-exec") && tokenId) {
    process.env.EXEC_MODE = "dry";
    const attempt = await executeSignal({
      qid: `selftest-${new Date().toISOString().slice(0, 10)}`,
      tokenId,
      conditionId: "selftest",
      outcome,
      question: "exec-selftest dry run",
      marketUrl: null,
      label: "🟢 selftest",
      stance: "selftest",
      bestAskAtSignal: bestAsk,
      budgetMs: 60_000,
      probe: true,
    });
    (attempt.status === "dry" ? ok : bad)(
      "dry-exec 全路径",
      `status=${attempt.status}${attempt.reason ? ` reason=${attempt.reason}` : ""} 拟买$${attempt.requestedUsd ?? "?"} @≤${attempt.limitPrice ?? "?"} (${attempt.latencyMs}ms)`
    );
  }

  // 5. --probe:$1 FAK @0.01 真实提交(必然 0 成交;postOrder 端到端验证)
  if (args.has("--probe") && tokenId && bestAsk != null && bestAsk >= 0.05) {
    try {
      const { Side, OrderType } = await import("@polymarket/clob-client-v2");
      const t0 = Date.now();
      const signed = await client.createMarketOrder({
        tokenID: tokenId,
        price: 0.01,
        amount: 1,
        side: Side.BUY,
        orderType: OrderType.FAK,
      });
      const resp = await client.postOrder(signed, OrderType.FAK);
      const ms = Date.now() - t0;
      console.log(`   probe 原始响应: ${JSON.stringify(resp).slice(0, 300)}`);
      const filled = Number(resp?.makingAmount) > 0;
      const accepted = resp?.success !== false && !/not allowed|invalid|unauthorized/i.test(resp?.errorMsg ?? "");
      (accepted ? ok : bad)(
        "probe 探针单(postOrder 端到端)",
        `${accepted ? "交易所已受理" : "被拒"}${filled ? ` ⚠意外成交 $${resp.makingAmount}` : "(0 成交,符合预期)"} ${ms}ms`
      );
      const cfg2 = execConfig();
      mkdirSync(path.dirname(cfg2.ledger), { recursive: true });
      appendFileSync(
        cfg2.ledger,
        `${JSON.stringify({ at: new Date().toISOString(), probe: true, mode: "live", status: filled ? "filled" : "none", reason: "selftest --probe $1 FAK @0.01", qid: "selftest-probe", tokenId, requestedUsd: 1, limitPrice: 0.01, posted: true, raw: resp })}\n`
      );
    } catch (err) {
      bad("probe 探针单", err instanceof Error ? (err as Error & { response?: { data?: unknown } }).message : String(err));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (err as any)?.response?.data;
      if (data) console.log(`   probe 错误响应体: ${JSON.stringify(data).slice(0, 300)}`);
    }
  }
}

main().catch((err) => {
  console.error(`[exec-selftest] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
