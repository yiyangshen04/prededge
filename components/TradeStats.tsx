"use client";

import type { PaperTrade } from "@/lib/types";

export function TradeStats({ trades }: { trades: PaperTrade[] }) {
  const open = trades.filter((t) => t.status === "open");
  const resolved = trades.filter((t) => t.status !== "open");
  const won = trades.filter((t) => t.status === "won");

  const totalInvested = trades.reduce((sum, t) => sum + t.usdAmount, 0);
  const totalPnl = resolved.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);
  const resolvedInvested = resolved.reduce((sum, t) => sum + t.usdAmount, 0);
  const totalReturnPct =
    resolvedInvested > 0 ? (totalPnl / resolvedInvested) * 100 : 0;
  const winRate = resolved.length > 0 ? won.length / resolved.length : 0;

  const openExposure = open.reduce((sum, t) => sum + t.usdAmount, 0);

  const cards: Array<{ label: string; value: string; className?: string }> = [
    {
      label: "Total P&L",
      value: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
      className: totalPnl >= 0 ? "text-accent-green" : "text-accent-red",
    },
    {
      label: "Return",
      value: `${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}%`,
      className: totalReturnPct >= 0 ? "text-accent-green" : "text-accent-red",
    },
    {
      label: "Win Rate",
      value: resolved.length > 0 ? `${(winRate * 100).toFixed(0)}%` : "—",
    },
    {
      label: "Open / Resolved",
      value: `${open.length} / ${resolved.length}`,
    },
    {
      label: "Open Exposure",
      value: `$${openExposure.toFixed(0)}`,
    },
    {
      label: "Total Invested",
      value: `$${totalInvested.toFixed(0)}`,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className="bg-bg-card border border-border rounded-lg p-3"
        >
          <div className="text-[10px] text-text-muted uppercase tracking-wider">
            {c.label}
          </div>
          <div
            className={`text-lg font-mono font-semibold mt-0.5 ${
              c.className || "text-text-primary"
            }`}
          >
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}
