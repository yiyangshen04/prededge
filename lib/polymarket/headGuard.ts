/**
 * 头块合理性守卫(从 chain-watch 主循环抽出共享,2026-07-19 审查 §4)。
 *
 * 触发器是历史上真实发生过的:多链网关(1rpc)误路由会返回另一条链的更高
 * 块号 —— 不设防时游标被毒化到假头,此后每 tick "no new blocks",通道静默
 * 死亡。对称地,远低于游标的头(滞后副本/误路由)会走"无新块"跳过路径,
 * 监控恒绿而扫描已停。
 *
 * 语义(与 chain-watch 2026-07 生产修复一致):
 *  - 首次运行(lastCursor ≤ 0)豁免;
 *  - 头跳超 maxAdvance:用反序 RPC 列表交叉核验 —— 两个独立端点一致(±5000)
 *    则接受(真实长停机;回看窗口钳制与 gap 告警自会兜底积压),不一致即
 *    throw(游标不动,下 tick 重试);
 *  - 头低于游标超 maxDrop:直接 throw(loud-fail,绝不静默当"无新块")。
 */
export async function guardHeadJump(input: {
  rawHead: number;
  lastCursor: number;
  /** 以反序(或独立)RPC 列表再取一次头,用于交叉核验。 */
  crossCheckHead: () => Promise<number>;
  /** 日志/错误前缀(chain-watch / onchain-events)。 */
  tag: string;
  /** 单 tick 允许的最大头跳(默认 ~4.8 天 Polygon 块)。 */
  maxAdvance?: number;
  /** 允许头低于游标的容差(滞后副本;默认 1000 块)。 */
  maxDrop?: number;
}): Promise<void> {
  const { rawHead, lastCursor, tag } = input;
  const maxAdvance = input.maxAdvance ?? 200_000;
  const maxDrop = input.maxDrop ?? 1_000;
  if (!(lastCursor > 0)) return;
  if (rawHead - lastCursor > maxAdvance) {
    let crossHead = NaN;
    try {
      crossHead = Number(await input.crossCheckHead());
    } catch {
      // 核验通道自身失败按不一致处理(下面统一 throw)
    }
    if (!Number.isFinite(crossHead) || Math.abs(crossHead - rawHead) > 5_000) {
      throw new Error(
        `[${tag}] implausible head ${rawHead} vs stored cursor ${lastCursor} (jump ${rawHead - lastCursor} > ${maxAdvance}); cross-check head ${crossHead} disagrees — refusing to advance`
      );
    }
    console.warn(
      `[${tag}] head jump ${rawHead - lastCursor} blocks confirmed by cross-check (${crossHead}) — accepting after long downtime`
    );
  }
  if (rawHead < lastCursor - maxDrop) {
    throw new Error(
      `[${tag}] implausible head ${rawHead} far below stored cursor ${lastCursor}; refusing to treat as "no new blocks"`
    );
  }
}
