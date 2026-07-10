/**
 * Automated order execution for chain-watch 🟢 signals (2026-07-10).
 *
 * Gate semantics live in chain-watch (identical to paper-trade registration:
 * 🟢 label = regex∧LLM double-confirm at conf=high, post M1/M2/M3 downgrades);
 * this module owns everything after the gate: risk caps, freshness re-check,
 * marketable-limit FAK order via CLOB V2, and the append-only trade ledger.
 *
 * Fail-open by design like execCheck: ANY failure here returns a TradeAttempt
 * (never throws), and the alert email always goes out — execution is an
 * enrichment of the alert path, never a gate on it.
 *
 * Access triple (verified read-only 2026-07-10, 8/8 + on-chain EIP-1271
 * pre-play): signer = EOA in ~/.prededge/trading-wallet.json, funder = proxy
 * 0x3a6075…6Db9, signatureType = 3 (POLY_1271; the order's signer field
 * equals the maker/proxy by design — EOA sig is ERC-7739-wrapped inside).
 *
 * Env:
 *   EXEC_MODE            off (default) | dry (全链路含签名,不 postOrder) | live
 *   EXEC_WALLET_JSON     default ~/.prededge/trading-wallet.json
 *   EXEC_CREDS_JSON      default ~/.prededge/clob-creds.json (L2 creds cache)
 *   EXEC_FUNDER          default 0x3a60750796A52e84DA325B74C5ad5c031f296Db9
 *   EXEC_MAX_ORDER_USD   default 50   (单笔上限)
 *   EXEC_DAILY_MAX_USD   default 150  (UTC 日累计上限,按 requested 计)
 *   EXEC_TOTAL_MAX_USD   default 400  (累计总上限 = 热钱包敞口上限)
 *   EXEC_MIN_ORDER_USD   default 5    (低于此值不值得付固定成本)
 *   EXEC_MAX_PRICE       default 0.97 (入场价上限;≥0.97 是尾价 carry,自动模式不吃)
 *   EXEC_MIN_PRICE       default 0.03 (入场价下限;防彩票区)
 *   EXEC_SLIPPAGE        default 0.03 (限价帽 = 新鲜 ask + slippage;信号价漂移超过它=已重定价,放弃)
 *   EXEC_SKIP_FORECAST_TEMPLATE  default on(bt5/E3b:预告模板家族绿档均值 −5.5%、零肥尾)
 *   EXEC_HALT_FILE       default data/trading-halt(存在即停;连续 3 次 live error 自动创建)
 *   EXEC_LEDGER          default data/trade-ledger.jsonl
 */
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import path from "path";
import { homedir } from "os";
import { CLOB_API } from "./config";

export type ExecMode = "off" | "dry" | "live";

export interface TradeAttempt {
  mode: ExecMode;
  /** filled/partial: 实际成交;none: FAK 未匹配即撤;dry: 已构造未提交;
   * skipped: 风控/条件不满足;error: 执行异常。 */
  status: "filled" | "partial" | "none" | "dry" | "skipped" | "error";
  reason?: string;
  orderId?: string;
  requestedUsd?: number;
  limitPrice?: number;
  /** 下单前重读盘口拿到的最优卖价(信号注解可能已过时数十秒)。 */
  freshAsk?: number | null;
  filledUsd?: number;
  filledShares?: number;
  avgPrice?: number;
  /** postOrder 是否已发出(true/false/"unknown" 超时未知)——资金占用按此计。 */
  posted?: boolean | "unknown";
  latencyMs?: number;
}

export interface TradeSignalInput {
  qid: string;
  tokenId: string;
  conditionId: string;
  outcome: string;
  question: string;
  marketUrl: string | null;
  /** priorityOf 的完整标签,进 ledger 供事后按档位归因。 */
  label: string;
  stance: string;
  llmStance?: string | null;
  llmConfidence?: string | null;
  /** 信号注解时刻的 bestAsk(漂移防护的基准;null = 注解时无盘口)。 */
  bestAskAtSignal: number | null;
  negRisk?: boolean;
  forecastTemplate?: boolean;
  correction?: boolean;
  /** 本 tick 剩余墙钟预算;不足则跳过,绝不拖垮告警路径。 */
  budgetMs: number;
  /** selftest/probe 专用:ledger 记录带 probe 标记,不参与去重与额度累计。 */
  probe?: boolean;
}

interface LedgerEntry extends TradeAttempt {
  at: string;
  qid: string;
  tokenId: string;
  conditionId?: string;
  outcome?: string;
  question?: string;
  label?: string;
  stance?: string;
  llmStance?: string | null;
  llmConfidence?: string | null;
  signalAsk?: number | null;
  probe?: boolean;
  raw?: unknown;
}

const num = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const expandHome = (p: string): string => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p);
const rel = (p: string): string => (path.isAbsolute(p) ? p : path.join(process.cwd(), p));

export function executionMode(): ExecMode {
  const m = (process.env.EXEC_MODE ?? "off").trim().toLowerCase();
  return m === "live" || m === "dry" ? m : "off";
}

export function execConfig() {
  return {
    mode: executionMode(),
    walletJson: expandHome(process.env.EXEC_WALLET_JSON?.trim() || "~/.prededge/trading-wallet.json"),
    credsJson: expandHome(process.env.EXEC_CREDS_JSON?.trim() || "~/.prededge/clob-creds.json"),
    funder: process.env.EXEC_FUNDER?.trim() || "0x3a60750796A52e84DA325B74C5ad5c031f296Db9",
    maxOrderUsd: num("EXEC_MAX_ORDER_USD", 50),
    dailyMaxUsd: num("EXEC_DAILY_MAX_USD", 150),
    totalMaxUsd: num("EXEC_TOTAL_MAX_USD", 400),
    minOrderUsd: num("EXEC_MIN_ORDER_USD", 5),
    maxPrice: num("EXEC_MAX_PRICE", 0.97),
    minPrice: num("EXEC_MIN_PRICE", 0.03),
    slippage: num("EXEC_SLIPPAGE", 0.03),
    skipForecastTemplate:
      (process.env.EXEC_SKIP_FORECAST_TEMPLATE ?? "on").trim().toLowerCase() !== "off",
    haltFile: rel(process.env.EXEC_HALT_FILE?.trim() || "data/trading-halt"),
    ledger: rel(process.env.EXEC_LEDGER?.trim() || "data/trade-ledger.jsonl"),
  };
}

// ── Ledger ──

function readLedger(ledgerPath: string): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // 半行(崩溃截断)容忍:append-only,坏行不影响后续
    }
  }
  return out;
}

function appendLedger(ledgerPath: string, entry: LedgerEntry): void {
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
}

/** live 且实际(可能)发出过订单的条目 —— 资金占用与去重的口径。 */
const committedLive = (e: LedgerEntry): boolean =>
  e.mode === "live" && !e.probe && (e.posted === true || e.posted === "unknown");

// ── CLOB client(进程内单例;chain-watch 每 tick 一个进程)──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let clientPromise: Promise<any> | null = null;

/** 已配置三元组(signer/funder/POLY_1271)与缓存 L2 creds 的 CLOB client。
 * 供 executeSignal 与 exec-selftest 共用;失败不缓存,下次调用重试。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getExecClient(): Promise<any> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const cfg = execConfig();
    // 动态 import:执行器依赖缺失/损坏时只废掉执行,绝不拖垮 chain-watch 告警主路径
    const [{ ClobClient, SignatureTypeV2 }, { Wallet }] = await Promise.all([
      import("@polymarket/clob-client-v2"),
      import("@ethersproject/wallet"),
    ]);
    const { privateKey } = JSON.parse(readFileSync(cfg.walletJson, "utf8")) as { privateKey: string };
    const wallet = new Wallet(privateKey);
    let creds: { key: string; secret: string; passphrase: string } | null = null;
    try {
      creds = JSON.parse(readFileSync(cfg.credsJson, "utf8"));
    } catch {
      // 首次运行:L1 签名派生 L2 creds 并缓存(约 0.5s,此后免掉)
    }
    if (!creds?.key) {
      const boot = new ClobClient({ host: CLOB_API, chain: 137, signer: wallet });
      creds = await boot.createOrDeriveApiKey();
      mkdirSync(path.dirname(cfg.credsJson), { recursive: true });
      writeFileSync(cfg.credsJson, JSON.stringify(creds, null, 1));
      chmodSync(cfg.credsJson, 0o600);
    }
    return new ClobClient({
      host: CLOB_API,
      chain: 137,
      signer: wallet,
      creds,
      funderAddress: cfg.funder,
      signatureType: SignatureTypeV2.POLY_1271,
    });
  })();
  clientPromise.catch(() => {
    clientPromise = null; // 失败不缓存,下次(下个 tick)重试
  });
  return clientPromise;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// ── 主入口 ──

/**
 * Execute (or dry-run) a BUY of the signal's directional outcome token.
 * Never throws. Always appends a ledger entry except for pure config-off.
 */
export async function executeSignal(input: TradeSignalInput): Promise<TradeAttempt> {
  const t0 = Date.now();
  const cfg = execConfig();
  const mode = executionMode();
  const finish = (a: TradeAttempt, raw?: unknown): TradeAttempt => {
    a.latencyMs = Date.now() - t0;
    try {
      appendLedger(cfg.ledger, {
        at: new Date().toISOString(),
        qid: input.qid,
        tokenId: input.tokenId,
        conditionId: input.conditionId,
        outcome: input.outcome,
        question: input.question?.slice(0, 160),
        label: input.label,
        stance: input.stance,
        llmStance: input.llmStance ?? null,
        llmConfidence: input.llmConfidence ?? null,
        signalAsk: input.bestAskAtSignal,
        ...(input.probe ? { probe: true } : {}),
        ...a,
        ...(raw !== undefined ? { raw } : {}),
      });
    } catch (err) {
      console.warn(
        `[trade-executor] ledger 写入失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return a;
  };

  if (mode === "off") return { mode, status: "skipped", reason: "EXEC_MODE=off" };

  try {
    // ── 风控闸(全部在任何网络调用之前)──
    if (existsSync(cfg.haltFile)) {
      return finish({ mode, status: "skipped", reason: `kill-switch 存在(${cfg.haltFile})` });
    }
    if (input.budgetMs < 12_000) {
      return finish({ mode, status: "skipped", reason: `tick 预算不足(${Math.round(input.budgetMs / 1000)}s)` });
    }
    if (input.forecastTemplate && cfg.skipForecastTemplate) {
      return finish({ mode, status: "skipped", reason: "预告模板家族(bt5/E3b 绿档均值−5.5%,EXEC_SKIP_FORECAST_TEMPLATE=on)" });
    }

    const ledger = readLedger(cfg.ledger);
    let dailyLeft = cfg.maxOrderUsd;
    let totalLeft = cfg.maxOrderUsd;
    if (!input.probe) {
      const dup = ledger.find(
        (e) =>
          e.tokenId === input.tokenId &&
          !e.probe &&
          (committedLive(e) || (mode === "dry" && e.mode === "dry" && e.status === "dry"))
      );
      if (dup) {
        return finish({ mode, status: "skipped", reason: `已对该 token 执行过(${dup.at} ${dup.status})` });
      }
      const today = new Date().toISOString().slice(0, 10);
      const spentToday = ledger
        .filter((e) => committedLive(e) && e.at?.slice(0, 10) === today)
        .reduce((s, e) => s + (e.requestedUsd ?? 0), 0);
      const spentTotal = ledger
        .filter(committedLive)
        .reduce((s, e) => s + (e.requestedUsd ?? 0), 0);
      if (mode === "live" && spentToday >= cfg.dailyMaxUsd) {
        return finish({ mode, status: "skipped", reason: `日额度已满($${spentToday.toFixed(0)}/${cfg.dailyMaxUsd})` });
      }
      if (mode === "live" && spentTotal >= cfg.totalMaxUsd) {
        return finish({ mode, status: "skipped", reason: `总敞口已满($${spentTotal.toFixed(0)}/${cfg.totalMaxUsd})` });
      }
      dailyLeft = Math.max(0, cfg.dailyMaxUsd - spentToday);
      totalLeft = Math.max(0, cfg.totalMaxUsd - spentTotal);
    }

    // ── 新鲜盘口(信号注解距此可能已过数十秒 LLM 判读)──
    const client = await withTimeout(getExecClient(), Math.min(15_000, input.budgetMs - 5_000), "client init");
    const book = (await withTimeout(
      client.getOrderBook(input.tokenId),
      8_000,
      "getOrderBook"
    )) as { asks?: Array<{ price: string; size: string }> };
    const asks = (book.asks ?? [])
      .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
      .sort((a, b) => a.price - b.price);
    const freshAsk = asks[0]?.price ?? null;
    if (freshAsk == null) {
      return finish({ mode, status: "skipped", reason: "盘口无卖单", freshAsk });
    }
    if (freshAsk > cfg.maxPrice) {
      return finish({
        mode,
        status: "skipped",
        reason: `ask ${freshAsk.toFixed(3)} > 上限 ${cfg.maxPrice}(尾价/已重定价)`,
        freshAsk,
      });
    }
    if (freshAsk < cfg.minPrice) {
      return finish({ mode, status: "skipped", reason: `ask ${freshAsk.toFixed(3)} < 下限 ${cfg.minPrice}`, freshAsk });
    }
    if (input.bestAskAtSignal != null && freshAsk > input.bestAskAtSignal + cfg.slippage) {
      return finish({
        mode,
        status: "skipped",
        reason: `信号后已重定价(注解 ${input.bestAskAtSignal.toFixed(3)} → 现 ${freshAsk.toFixed(3)},超滑点带 ${cfg.slippage})`,
        freshAsk,
      });
    }

    const limitPrice = Math.min(
      Math.round((freshAsk + cfg.slippage) * 100) / 100,
      cfg.maxPrice,
      0.99
    );
    const depthUsd = asks
      .filter((l) => l.price <= limitPrice)
      .reduce((s, l) => s + l.price * l.size, 0);
    const orderUsd = Math.floor(Math.min(cfg.maxOrderUsd, dailyLeft, totalLeft, depthUsd * 0.9));
    if (orderUsd < cfg.minOrderUsd) {
      return finish({
        mode,
        status: "skipped",
        reason: `可用额度/限价内深度不足(可下 $${orderUsd},最低 $${cfg.minOrderUsd};深度 $${depthUsd.toFixed(0)})`,
        freshAsk,
        limitPrice,
      });
    }

    // negRisk 已知时传给 client 省一次串行往返;version/tickSize 让 client 自己
    // 解析(2026-04-28 V2 迁移一夜废掉全部旧 bot 的教训:版本绝不硬编码)。
    const orderOptions = input.negRisk !== undefined ? { negRisk: input.negRisk } : undefined;

    if (mode === "dry") {
      // 干跑也走完构单+签名(校验签名路径与参数),只差 postOrder
      const { Side, OrderType } = await import("@polymarket/clob-client-v2");
      await withTimeout(
        client.createMarketOrder(
          {
            tokenID: input.tokenId,
            price: limitPrice,
            amount: orderUsd,
            side: Side.BUY,
            orderType: OrderType.FAK,
          },
          orderOptions
        ),
        Math.min(30_000, input.budgetMs - 5_000),
        "createMarketOrder(dry)"
      );
      return finish({
        mode,
        status: "dry",
        reason: "EXEC_MODE=dry(已构单+签名,未提交)",
        freshAsk,
        limitPrice,
        requestedUsd: orderUsd,
        posted: false,
      });
    }

    // ── live ──
    const { Side, OrderType } = await import("@polymarket/clob-client-v2");
    const signed = await withTimeout(
      client.createMarketOrder(
        {
          tokenID: input.tokenId,
          price: limitPrice,
          amount: orderUsd,
          side: Side.BUY,
          orderType: OrderType.FAK,
        },
        orderOptions
      ),
      Math.min(30_000, input.budgetMs - 8_000),
      "createMarketOrder"
    );
    let resp: {
      success?: boolean;
      errorMsg?: string;
      orderID?: string;
      status?: string;
      takingAmount?: string;
      makingAmount?: string;
    };
    try {
      resp = await withTimeout(client.postOrder(signed, OrderType.FAK), 20_000, "postOrder");
    } catch (err) {
      // 超时后订单可能已被交易所接受 —— posted=unknown,按已占用额度计
      const msg = err instanceof Error ? err.message : String(err);
      const attempt = finish(
        {
          mode,
          status: "error",
          reason: `postOrder: ${msg}`,
          freshAsk,
          limitPrice,
          requestedUsd: orderUsd,
          posted: /timed out/.test(msg) ? "unknown" : false,
        },
        undefined
      );
      autoHaltOnRepeatedErrors(cfg);
      return attempt;
    }

    const shares = Number(resp?.takingAmount);
    const usd = Number(resp?.makingAmount);
    const haveFill = Number.isFinite(shares) && shares > 0 && Number.isFinite(usd) && usd > 0;
    if (resp?.success === false || (resp?.errorMsg && !haveFill)) {
      const attempt = finish(
        {
          mode,
          status: "error",
          reason: `CLOB 拒单: ${resp?.errorMsg ?? JSON.stringify(resp).slice(0, 200)}`,
          freshAsk,
          limitPrice,
          requestedUsd: orderUsd,
          posted: true,
        },
        resp
      );
      autoHaltOnRepeatedErrors(cfg);
      return attempt;
    }
    if (!haveFill) {
      return finish(
        {
          mode,
          status: "none",
          reason: `FAK 未成交即撤(status=${resp?.status ?? "?"})`,
          orderId: resp?.orderID,
          freshAsk,
          limitPrice,
          requestedUsd: orderUsd,
          posted: true,
        },
        resp
      );
    }
    return finish(
      {
        mode,
        status: usd >= orderUsd * 0.95 ? "filled" : "partial",
        orderId: resp?.orderID,
        freshAsk,
        limitPrice,
        requestedUsd: orderUsd,
        filledUsd: Math.round(usd * 100) / 100,
        filledShares: Math.round(shares * 100) / 100,
        avgPrice: Math.round((usd / shares) * 1000) / 1000,
        posted: true,
      },
      resp
    );
  } catch (err) {
    const attempt = finish({
      mode,
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
      posted: false,
    });
    autoHaltOnRepeatedErrors(cfg);
    return attempt;
  }
}

/** 连续 3 次 live error → 自动落 kill-switch 文件(带原因),宁停不重复烧钱。
 * skipped/none 不算 error;人工删除该文件即恢复。 */
function autoHaltOnRepeatedErrors(cfg: ReturnType<typeof execConfig>): void {
  try {
    const entries = readLedger(cfg.ledger).filter((e) => e.mode === "live" && !e.probe);
    const tail = entries.slice(-3);
    if (tail.length === 3 && tail.every((e) => e.status === "error")) {
      mkdirSync(path.dirname(cfg.haltFile), { recursive: true });
      writeFileSync(
        cfg.haltFile,
        `auto-halt ${new Date().toISOString()}: 连续 3 次 live 执行错误,详见 ${cfg.ledger} 尾部。人工排查后删除本文件恢复。\n`
      );
      console.error(`[trade-executor] 连续 3 次 live error — 已自动创建 kill-switch ${cfg.haltFile}`);
    }
  } catch {
    // 自动熔断是尽力而为
  }
}
