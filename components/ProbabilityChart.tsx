"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface ProbabilityPoint {
  weekStart: string; // ISO date
  probability: number; // 0-1
  outcome?: "YES" | "NO" | "OPEN" | null;
  marketYes?: number | null; // 0-1
}

interface Props {
  points: ProbabilityPoint[];
}

export function ProbabilityChart({ points }: Props) {
  if (points.length === 0) {
    return (
      <div className="bg-bg-card border border-border rounded-lg p-6 text-center text-text-muted text-sm">
        No predictions yet. Click <span className="font-mono">Refresh</span> to
        compute one for this week.
      </div>
    );
  }

  const data = points.map((p) => ({
    label: p.weekStart.slice(5), // mm-dd
    weekStart: p.weekStart,
    probability: Math.round(p.probability * 1000) / 10, // %
    market: p.marketYes == null ? null : Math.round(p.marketYes * 1000) / 10,
    actual:
      p.outcome === "YES" ? 100 : p.outcome === "NO" ? 0 : null,
    actualOutcome: p.outcome ?? null,
  }));

  return (
    <div className="bg-bg-card border border-border rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-medium text-text-primary">
          Predicted P(buy) over time
        </h3>
        <div className="text-xs text-text-muted flex gap-3">
          <span>
            <span className="inline-block w-2 h-2 rounded-full bg-accent-blue mr-1" />
            our prob
          </span>
          <span>
            <span className="inline-block w-2 h-2 rounded-full bg-accent-amber mr-1" />
            market YES
          </span>
          <span>
            <span className="inline-block w-2 h-2 rounded-full bg-accent-green mr-1" />
            YES
          </span>
          <span>
            <span className="inline-block w-2 h-2 rounded-full bg-accent-red mr-1" />
            NO
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart
          data={data}
          margin={{ top: 10, right: 16, bottom: 10, left: 0 }}
        >
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
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
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
            formatter={(value, name) => {
              if (value == null) return ["—", name];
              return [`${Number(value).toFixed(1)}%`, name];
            }}
          />
          <ReferenceLine
            y={50}
            stroke="var(--text-muted)"
            strokeDasharray="2 2"
          />
          <Area
            type="monotone"
            dataKey="probability"
            name="our prob"
            stroke="var(--accent-blue)"
            fill="var(--accent-blue)"
            fillOpacity={0.15}
            strokeWidth={2}
          />
          <Line
            type="monotone"
            dataKey="market"
            name="market YES"
            stroke="var(--accent-amber)"
            strokeWidth={1.5}
            strokeDasharray="4 2"
            dot={false}
          />
          <Scatter
            dataKey="actual"
            name="actual"
            shape={(props: unknown) => {
              const p = props as {
                cx?: number;
                cy?: number;
                payload?: { actualOutcome?: "YES" | "NO" | null };
              };
              const cx = p.cx;
              const cy = p.cy;
              if (typeof cx !== "number" || typeof cy !== "number") {
                return <g />;
              }
              const outcome = p.payload?.actualOutcome;
              const color =
                outcome === "YES"
                  ? "var(--accent-green)"
                  : outcome === "NO"
                  ? "var(--accent-red)"
                  : "var(--text-muted)";
              return <circle cx={cx} cy={cy} r={4} fill={color} />;
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
