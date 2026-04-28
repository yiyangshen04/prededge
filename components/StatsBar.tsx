"use client";

import type { ScanRun } from "@/lib/types";

function StatCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "warn" | "danger";
}) {
  const toneClass =
    tone === "danger"
      ? "border-accent-red/50 bg-accent-red/10"
      : tone === "warn"
        ? "border-accent-amber/50 bg-accent-amber/10"
        : "border-border bg-bg-card";
  const textClass =
    tone === "danger"
      ? "text-accent-red"
      : tone === "warn"
        ? "text-accent-amber"
        : "text-text-primary";
  return (
    <div className={`border rounded-lg px-4 py-3 ${toneClass}`}>
      <div className="text-xs text-text-muted uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className={`text-xl font-mono font-semibold ${textClass}`}>
        {value}
      </div>
    </div>
  );
}

export function StatsBar({ scan }: { scan: ScanRun | null }) {
  if (!scan) {
    return (
      <div className="text-text-muted text-sm py-4">
        No scan data yet. Click &ldquo;Run Scan&rdquo; to start.
      </div>
    );
  }

  const completedMs = scan.completedAt
    ? new Date(scan.completedAt).getTime()
    : null;
  const ageMin =
    completedMs && !Number.isNaN(completedMs)
      ? (new Date().getTime() - completedMs) / 60_000
      : null;
  const timeAgo = completedMs
    ? formatTimeAgo(new Date(completedMs))
    : "running...";
  // Data > 30 min stale = danger (price/depth likely drifted). > 5 min = warn.
  // Scan triggers on demand, so if the user didn't click "Scan" recently the
  // list they see may not match live Polymarket anymore — we want that fact to
  // be impossible to miss.
  const staleTone: "neutral" | "warn" | "danger" =
    ageMin == null ? "neutral" : ageMin > 30 ? "danger" : ageMin > 5 ? "warn" : "neutral";

  return (
    <div className="space-y-2">
      {staleTone !== "neutral" && (
        <div
          className={`text-xs px-3 py-2 rounded-md border ${
            staleTone === "danger"
              ? "border-accent-red/40 bg-accent-red/10 text-accent-red"
              : "border-accent-amber/40 bg-accent-amber/10 text-accent-amber"
          }`}
        >
          {staleTone === "danger"
            ? "Scan is >30 min old — prices/depth have likely shifted. Click Scan to refresh before trading."
            : "Scan is >5 min old — verify against Polymarket before acting on an opportunity."}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Markets Scanned" value={scan.marketsScanned.toLocaleString()} />
        <StatCard label="Candidates" value={scan.candidatesFound} />
        <StatCard label="Actionable" value={scan.actionableCount} />
        <StatCard label="Observe" value={scan.observeCount} />
        <StatCard label="Last Scan" value={timeAgo} tone={staleTone} />
      </div>
    </div>
  );
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
