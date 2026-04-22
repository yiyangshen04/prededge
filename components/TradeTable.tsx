"use client";

import type { PaperTrade } from "@/lib/types";

export function TradeTable({ trades }: { trades: PaperTrade[] }) {
  if (trades.length === 0) {
    return (
      <div className="bg-bg-card border border-border rounded-lg p-8 text-center text-text-muted text-sm">
        No trades yet. Click Buy YES / Buy NO on any opportunity to start paper trading.
      </div>
    );
  }

  return (
    <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-bg-input border-b border-border">
            <tr className="text-text-muted">
              <th className="text-left px-3 py-2 font-medium">Market</th>
              <th className="text-left px-2 py-2 font-medium">Side</th>
              <th className="text-right px-2 py-2 font-medium">Invested</th>
              <th className="text-right px-2 py-2 font-medium">Shares</th>
              <th className="text-right px-2 py-2 font-medium">Avg Fill</th>
              <th className="text-left px-2 py-2 font-medium">Status</th>
              <th className="text-right px-2 py-2 font-medium">P&amp;L</th>
              <th className="text-right px-2 py-2 font-medium">Return</th>
              <th className="text-left px-2 py-2 font-medium">When</th>
              <th className="text-left px-2 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr
                key={t.id}
                className="border-b border-border last:border-b-0 hover:bg-bg-card-hover transition-colors"
              >
                <td
                  className="px-3 py-2 max-w-[260px] truncate text-text-primary"
                  title={t.marketQuestion}
                >
                  {t.marketQuestion}
                </td>
                <td className="px-2 py-2">
                  <span
                    className={`px-1.5 py-0.5 rounded font-semibold ${
                      t.outcomeBought.toLowerCase() === "yes"
                        ? "bg-accent-green/15 text-accent-green"
                        : "bg-accent-red/15 text-accent-red"
                    }`}
                  >
                    {t.outcomeBought.toUpperCase()}
                  </span>
                </td>
                <td className="px-2 py-2 text-right font-mono text-text-primary">
                  ${t.usdAmount.toFixed(2)}
                </td>
                <td className="px-2 py-2 text-right font-mono text-text-secondary">
                  {t.shares.toFixed(2)}
                </td>
                <td className="px-2 py-2 text-right font-mono text-text-secondary">
                  ${t.avgFillPrice.toFixed(4)}
                </td>
                <td className="px-2 py-2">
                  <StatusBadge status={t.status} />
                </td>
                <td
                  className={`px-2 py-2 text-right font-mono ${pnlColor(t)}`}
                >
                  {t.pnlUsd == null
                    ? "—"
                    : `${t.pnlUsd >= 0 ? "+" : ""}$${t.pnlUsd.toFixed(2)}`}
                </td>
                <td className={`px-2 py-2 text-right font-mono ${pnlColor(t)}`}>
                  {t.pnlPct == null
                    ? "—"
                    : `${t.pnlPct >= 0 ? "+" : ""}${(t.pnlPct * 100).toFixed(1)}%`}
                </td>
                <td className="px-2 py-2 text-text-muted whitespace-nowrap">
                  {new Date(t.resolvedAt ?? t.createdAt).toLocaleDateString(
                    undefined,
                    { month: "short", day: "numeric" }
                  )}
                </td>
                <td className="px-2 py-2">
                  {t.marketUrl && (
                    <a
                      href={t.marketUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent-blue hover:underline"
                    >
                      View →
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: PaperTrade["status"] }) {
  const styles: Record<PaperTrade["status"], string> = {
    open: "bg-accent-blue/15 text-accent-blue",
    won: "bg-accent-green/15 text-accent-green",
    lost: "bg-accent-red/15 text-accent-red",
    void: "bg-text-muted/15 text-text-muted",
  };
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function pnlColor(t: PaperTrade): string {
  if (t.pnlUsd == null) return "text-text-muted";
  return t.pnlUsd > 0
    ? "text-accent-green"
    : t.pnlUsd < 0
      ? "text-accent-red"
      : "text-text-muted";
}
