<div align="center">

# ⚡ PredEdge

**Polymarket 尾价机会扫描 · 争议监控 · 纸面交易追踪**

**Tail-price opportunity scanner, dispute watcher & paper-trading tracker for Polymarket**

[简体中文](#-简体中文) · [English](#-english)

<br/>

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-339933?logo=node.js&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white)

</div>

---

## 🇨🇳 简体中文

PredEdge 是一个 **local-first** 的 [Next.js](https://nextjs.org) 应用:全量扫描 Polymarket 尾价区(0.93–0.995)合约,逐档吃单计算真实成交 VWAP 与滑点,结合链上 UMA 预言机争议状态与官方澄清文本打分,并支持纸面交易验证策略表现。同时内置一套无头 cron 运维体系(邮件告警 + 链上降级模式 + 心跳监控),可跑在一台小服务器上 7×24 盯盘。

### ✨ 功能一览

| 页面 | 说明 |
| --- | --- |
| 🔍 **扫描器** `/` | 全量扫 Polymarket 尾价合约,吃穿订单簿 ask 侧计算 fill-aware VWAP 与滑点,按可行 / 观察 / 拒绝三档打分排序;支持按标签过滤、按自定义仓位实时重算;展示链上争议事件与 dispute-coverage 数据 |
| 📒 **纸面交易** `/trades` | 对扫描出的机会模拟建仓,持续追踪扫描器选中标的的真实走势与盈亏 |
| 📊 **MSTR 报告** `/mstr` | Polymarket × Saylor 严格信号周度 BTC 策略的回测复盘与实时验证 |
| 🐦 **Saylor 信号** `/saylor` | 综合 @saylor 推文线索、财报日历、美国联邦假日与资本运作,预测 MSTR 下周买入 BTC 的概率 |

### 🛰 无头运维(cron)

| 脚本 | 用途 |
| --- | --- |
| `npm run scan:notify` | 无头扫描 + 邮件通知:探测 Gamma 可达性 → 全量扫描 → 状态文件去重防轰炸 → 只对新机会 / 状态变化发 HTML 邮件 |
| `npx tsx scripts/chain-watch.ts` | **争议监控主通道**:只依赖 Polygon RPC(多节点冗余),扫 `QuestionReset` / `AncillaryDataUpdated` 事件,读官方澄清文本 → 正则分类 + headless Claude(Opus 4.8)二读 → 分级告警(🟢🔥 肥尾候选 / 🟢 双确认·高置信 / 🟠 方向存疑 / 🔵 LLM 独判),附盘口可执行性注解与自动 paper-trade 登记;含逆共识红旗、肥尾复判、洪水汇总限流 |
| `npx tsx scripts/heartbeat.ts --watch` | 心跳监控:两条通道标记文件超龄发告警,恢复发恢复邮件(边沿触发,不轰炸) |
| `npx tsx scripts/heartbeat.ts --daily` | 每日运行日报,本身兼作日频"系统活着"心跳 |
| `npm run mail:test` | SMTP 发信配置自检 |

### 🚀 快速开始

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000),在扫描器页点击 **Scan** 拉取最新市场(首次约 30–60 秒)。

> **请在本地运行。** 一次全量扫描要遍历数千个市场,耗时 30–60 秒,超出 Vercel serverless 函数的执行时限 —— 部署在 Vercel 上触发扫描大概率超时,本地运行则没有此限制。

### 🏗 架构

```mermaid
flowchart LR
    G[Gamma API / CLOB 订单簿] --> S[扫描引擎<br/>VWAP · 滑点 · 打分]
    P[Polygon RPC<br/>UMA 预言机事件] --> S
    P --> C[chain-watch<br/>纯链上降级模式]
    S --> DB[(SQLite<br/>data/prededge.sqlite)]
    DB --> UI[Web UI<br/>/ · /trades · /mstr · /saylor]
    S --> N[scan-notify CLI]
    N --> M[📧 SMTP 邮件告警]
    C --> M
    H[heartbeat 监控] --> M
```

### ⚙️ 环境变量

| 变量 | 说明 |
| --- | --- |
| `LOCAL_DB_PATH` | SQLite 数据库路径(默认 `data/prededge.sqlite`) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | SMTP 服务器配置 |
| `MAIL_USER` / `MAIL_AUTH_CODE` | 发信账号与授权码 |
| `MAIL_FROM_NAME` / `MAIL_TO` | 发件人显示名 / 收件地址 |
| `POLYGON_RPC_URL` | 应用内链上读取所用的 Polygon RPC |
| `ONCHAIN_RPC_URLS` | chain-watch 的 RPC 列表(逗号分隔,多节点冗余) |
| `CHAIN_WATCH_STATE` | chain-watch 状态文件路径(默认 `data/chain-watch-state.json`) |
| `HC_PING_SCAN_NOTIFY` / `HC_PING_CHAIN_WATCH` | healthchecks.io 外部保活 ping 地址 |
| `CLAUDE_CODE_OAUTH_TOKEN` | headless Claude 判读的认证(`claude setup-token` 生成);缺省时 LLM 二读关闭,回退纯正则分级 |
| `LLM_STANCE` / `LLM_STANCE_MODEL` | `off` 关闭 LLM 二读 / 判读模型(默认 `claude-opus-4-8`) |
| `LLM_BOUNDARY_GUARD` | `off` 关闭边界闸门标注(A/B 用) |
| `PAPER_TRADES_AUTO` | `off` 关闭 🟢 信号自动登记 paper_trades |

### 📐 分级依据(15 个月真实成交回测,2026-07)

告警分级不是拍脑袋:基于 2,182 个历史信号、~3,800 次 Opus 4.8 生产原语义判读、data-api 真实成交定价的回测(bt3/bt4):**🟢 只授予"正则∧LLM 双确认且高置信"**——该档位是唯一跨 prompt 配置稳健的正收益结构(样本内 20/20);中置信双确认降 🟠(历史全部 -100% 级亏损所在);报警照发、只降标签。极端逆共识(方向价 <0.15)且非决断句式一律红旗。判读为文本判读(never predict the event):模型只读官方链上文本,方向必须有逐字引文背书,反幻觉门拒绝无引文的方向判读。详见项目内回测报告 PDF。

### 💾 数据存储

扫描批次、机会、赔率快照与纸面交易全部存在本地 SQLite(Node 内置 `node:sqlite` 模块驱动),首次 API 请求时自动建库,**无需任何外部数据库**。要求 Node.js ≥ 24(需支持 `node:sqlite`)。

---

## 🇬🇧 English

PredEdge is a **local-first** [Next.js](https://nextjs.org) app that sweeps Polymarket's tail-price band (0.93–0.995), walks the ask side of each order book to compute fill-aware VWAP and slippage, scores every candidate with on-chain UMA oracle dispute state and official clarification text, and lets you paper-trade the picks to verify how the strategy actually performs. It ships with a headless cron ops suite (email alerts + chain-only degraded mode + heartbeat monitoring) so it can watch the market 24/7 from a small box.

### ✨ Features

| Page | Description |
| --- | --- |
| 🔍 **Scanner** `/` | Sweeps Polymarket for tail-priced contracts, walks the order-book asks for fill-aware VWAP & slippage, scores and sorts candidates into actionable / observe / rejected; filter by tag, recompute live at your own trade size; surfaces on-chain dispute events and dispute-coverage data |
| 📒 **Paper Trading** `/trades` | Simulate buying into scanned opportunities and track how the scanner's picks actually play out |
| 📊 **MSTR Report** `/mstr` | Backtest review and live verification of the Polymarket × Saylor strict-signal weekly BTC strategy |
| 🐦 **Saylor BTC Signal** `/saylor` | Combines @saylor tweet cues, the earnings calendar, federal holidays, and capital actions into a probability that MSTR buys BTC next week |

### 🛰 Headless Ops (cron)

| Script | Purpose |
| --- | --- |
| `npm run scan:notify` | Headless scan + email alerts: probe Gamma reachability → full scan → dedupe via a state file → send HTML mail only for new opportunities / state changes |
| `npx tsx scripts/chain-watch.ts` | **Primary dispute watcher**: depends solely on Polygon RPCs (multi-node redundancy), sweeps `QuestionReset` / `AncillaryDataUpdated` events, reads official context from chain → regex classifier + headless Claude (Opus 4.8) second read → tiered alerts (🟢🔥 fat-tail candidate / 🟢 double-confirmed high-confidence / 🟠 direction doubtful / 🔵 LLM-only), with order-book executability annotations and automatic paper-trade registration; includes a contra-consensus red flag, fat-tail revote, and flood digest throttling |
| `npx tsx scripts/heartbeat.ts --watch` | Heartbeat monitor: alerts when either channel's marker file goes stale, sends a recovery mail when it heals (edge-triggered, no spam) |
| `npx tsx scripts/heartbeat.ts --daily` | Daily ops report, doubling as a daily "system alive" heartbeat |
| `npm run mail:test` | SMTP configuration self-test |

### 🚀 Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and click **Scan** on the Scanner page to fetch the latest markets (the first run takes 30–60s).

> **Run it locally.** A full scan walks thousands of markets and can take 30–60s, which exceeds Vercel's serverless function execution limit — a scan triggered on a Vercel deployment will likely time out. Running locally has no such limit.

### 🏗 Architecture

```mermaid
flowchart LR
    G[Gamma API / CLOB order books] --> S[Scan engine<br/>VWAP · slippage · scoring]
    P[Polygon RPC<br/>UMA oracle events] --> S
    P --> C[chain-watch<br/>chain-only degraded mode]
    S --> DB[(SQLite<br/>data/prededge.sqlite)]
    DB --> UI[Web UI<br/>/ · /trades · /mstr · /saylor]
    S --> N[scan-notify CLI]
    N --> M[📧 SMTP mail alerts]
    C --> M
    H[heartbeat monitor] --> M
```

### ⚙️ Environment Variables

| Variable | Description |
| --- | --- |
| `LOCAL_DB_PATH` | SQLite database path (default `data/prededge.sqlite`) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | SMTP server configuration |
| `MAIL_USER` / `MAIL_AUTH_CODE` | Sender account and auth code |
| `MAIL_FROM_NAME` / `MAIL_TO` | Sender display name / recipient address |
| `POLYGON_RPC_URL` | Polygon RPC used for on-chain reads inside the app |
| `ONCHAIN_RPC_URLS` | RPC list for chain-watch (comma-separated, multi-node redundancy) |
| `CHAIN_WATCH_STATE` | chain-watch state file path (default `data/chain-watch-state.json`) |
| `HC_PING_SCAN_NOTIFY` / `HC_PING_CHAIN_WATCH` | healthchecks.io external liveness ping URLs |
| `CLAUDE_CODE_OAUTH_TOKEN` | Auth for headless Claude second reads (from `claude setup-token`); when absent the LLM read is off and tiering falls back to regex only |
| `LLM_STANCE` / `LLM_STANCE_MODEL` | `off` disables the LLM second read / judgment model (default `claude-opus-4-8`) |
| `LLM_BOUNDARY_GUARD` | `off` disables the boundary-clarification tag (for A/B) |
| `PAPER_TRADES_AUTO` | `off` disables automatic paper-trade registration of 🟢 signals |

### 📐 How the tiers were chosen (15-month real-fill backtest, 2026-07)

The alert tiers are backtest-derived, not vibes: 2,182 historical signals, ~3,800 Opus 4.8 production-semantics judgments, priced against data-api real fills (bt3/bt4). **🟢 is granted only to "regex ∧ LLM double-confirmed at high confidence"** — the single structure that stayed positive across every prompt configuration tested (20/20 in-sample); medium-confidence double-confirms are demoted to 🟠 (where every historical −100% loss lived); mail still goes out — only the label drops. Extreme contra-consensus reads (direction priced < 0.15) get red-flagged unless the ruling is decisive. The LLM judges TEXT ONLY (never predicts events): directional verdicts must quote the official on-chain text verbatim, and an anti-hallucination gate rejects any directional call without a verbatim quote. See the backtest report PDFs in the repo.

### 💾 Local Storage

Scan runs, opportunities, odds snapshots, and paper trades all live in a local SQLite database powered by Node's built-in `node:sqlite` module. The database is created automatically on the first API request — **no external database required**. Requires Node.js ≥ 24 (with `node:sqlite` support).

---

<div align="center">
<sub>Built with Next.js · Local-first · No external database</sub>
</div>
