PredEdge is a local-first [Next.js](https://nextjs.org) app for scanning
Polymarket tail-price opportunities and tracking paper trades.

## Features

- **Scanner** (`/`) — Sweeps Polymarket for tail-priced contracts (0.93–0.995),
  walks the ask side of each order book to compute fill-aware VWAP and slippage,
  then scores and sorts every candidate into actionable / observe / rejected.
  Filter by tag and recompute yields live at your own trade size.
- **Paper Trading** (`/trades`) — Simulate buying into scanned opportunities and
  track how the scanner's picks actually play out.
- **MSTR Report** (`/mstr`) — Backtest review and live verification of the
  Polymarket × Saylor strict-signal weekly BTC strategy.
- **Saylor BTC Signal** (`/saylor`) — Combines @saylor tweet cues, the earnings
  calendar, federal holidays, and capital actions into a probability that MSTR
  buys BTC next week.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and click **Scan** on the
Scanner page to fetch the latest markets (the first run takes 30–60s).

> **Run it locally.** A full scan walks thousands of markets and can take
> 30–60s, which exceeds Vercel's serverless function execution limit — a scan
> triggered on a Vercel deployment will likely time out. Running locally has no
> such limit.

## Local Storage

The app stores scan runs, opportunities, odds snapshots, and paper trades in a
local SQLite database powered by Node's built-in `node:sqlite` module.

- Default database file: `data/prededge.sqlite`
- Override path: `LOCAL_DB_PATH=/absolute/or/relative/file.sqlite npm run dev`
- No Supabase environment variables are required.
- Requires a Node.js runtime with `node:sqlite` support. This workspace was
  tested with Node v25.2.1.

The database is created automatically on first API request.
