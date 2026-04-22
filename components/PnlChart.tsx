"use client";

import type { PaperTrade } from "@/lib/types";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

interface Point {
  t: number; // epoch ms
  label: string;
  pnl: number;
  cumulativePnl: number;
}

export function PnlChart({ trades }: { trades: PaperTrade[] }) {
  const resolved = trades
    .filter((t) => t.status !== "open" && t.resolvedAt)
    .sort(
      (a, b) =>
        new Date(a.resolvedAt!).getTime() - new Date(b.resolvedAt!).getTime()
    );

  if (resolved.length === 0) {
    return (
      <div className="bg-bg-card border border-border rounded-lg p-8 text-center text-text-muted text-sm">
        No resolved trades yet — P&L curve will appear once trades settle.
        <div className="text-xs mt-1">Click &quot;Refresh&quot; to check for resolutions.</div>
      </div>
    );
  }

  let running = 0;
  const data: Point[] = resolved.map((t) => {
    running += t.pnlUsd ?? 0;
    const ts = new Date(t.resolvedAt!);
    return {
      t: ts.getTime(),
      label: ts.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
      pnl: t.pnlUsd ?? 0,
      cumulativePnl: Math.round(running * 100) / 100,
    };
  });

  const isPositive = running >= 0;

  return (
    <div className="bg-bg-card border border-border rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-medium text-text-primary">
          Cumulative P&amp;L
        </h3>
        <span
          className={`text-lg font-mono font-semibold ${
            isPositive ? "text-accent-green" : "text-accent-red"
          }`}
        >
          {isPositive ? "+" : ""}${running.toFixed(2)}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            opacity={0.5}
          />
          <XAxis
            dataKey="label"
            stroke="var(--text-muted)"
            tick={{ fontSize: 11 }}
          />
          <YAxis
            stroke="var(--text-muted)"
            tick={{ fontSize: 11 }}
            tickFormatter={(v) => `$${v}`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              fontSize: "12px",
            }}
            labelStyle={{ color: "var(--text-muted)" }}
            itemStyle={{ color: "var(--text-primary)" }}
            formatter={(value) => [`$${Number(value).toFixed(2)}`, "Cumulative"]}
          />
          <ReferenceLine y={0} stroke="var(--text-muted)" strokeDasharray="2 2" />
          <Line
            type="monotone"
            dataKey="cumulativePnl"
            stroke={isPositive ? "var(--accent-green)" : "var(--accent-red)"}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
