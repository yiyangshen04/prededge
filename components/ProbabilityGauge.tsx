"use client";

/**
 * Half-circle probability gauge. Pure SVG, no deps.
 * 0% = left (red), 50% = top (amber), 100% = right (green).
 */
export function ProbabilityGauge({
  probability,
  size = 200,
}: {
  probability: number; // 0-1
  size?: number;
}) {
  const radius = size / 2 - 16;
  const cx = size / 2;
  const cy = size / 2 + 4;
  const startAngle = Math.PI; // 180°
  const endAngle = 0;
  const pct = Math.max(0, Math.min(1, probability));
  const angle = startAngle - pct * Math.PI;

  // Outer arc path (background, full half-circle)
  const arcStart = polar(cx, cy, radius, startAngle);
  const arcEnd = polar(cx, cy, radius, endAngle);
  const fillEnd = polar(cx, cy, radius, angle);

  const color =
    pct >= 0.7
      ? "var(--accent-green)"
      : pct <= 0.3
      ? "var(--accent-red)"
      : "var(--accent-amber)";

  // Large-arc-flag = 0 for half-circle paths
  const bgPath = `M ${arcStart.x} ${arcStart.y} A ${radius} ${radius} 0 0 1 ${arcEnd.x} ${arcEnd.y}`;
  const fgPath = `M ${arcStart.x} ${arcStart.y} A ${radius} ${radius} 0 0 1 ${fillEnd.x} ${fillEnd.y}`;

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size * 0.65} viewBox={`0 0 ${size} ${size * 0.65}`}>
        <path
          d={bgPath}
          stroke="var(--border)"
          strokeWidth={12}
          fill="none"
          strokeLinecap="round"
        />
        <path
          d={fgPath}
          stroke={color}
          strokeWidth={12}
          fill="none"
          strokeLinecap="round"
          style={{ transition: "all 0.5s ease" }}
        />
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          fontSize={size * 0.22}
          fontWeight="600"
          fill="var(--text-primary)"
          fontFamily="var(--font-geist-mono), monospace"
        >
          {Math.round(pct * 100)}%
        </text>
        <text
          x={cx}
          y={cy + size * 0.1}
          textAnchor="middle"
          fontSize={11}
          fill="var(--text-muted)"
          fontFamily="var(--font-geist-mono), monospace"
        >
          P(BUY)
        </text>
      </svg>
    </div>
  );
}

function polar(cx: number, cy: number, r: number, theta: number) {
  return { x: cx + r * Math.cos(theta), y: cy - r * Math.sin(theta) };
}
