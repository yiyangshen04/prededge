"use client";

import type { ScanRun } from "@/lib/types";

function StatCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "good" | "warn" | "danger";
}) {
  const toneClass =
    tone === "danger"
      ? "border-accent-red/50 bg-accent-red/10"
      : tone === "warn"
        ? "border-accent-amber/50 bg-accent-amber/10"
        : "";
  const textClass =
    tone === "danger"
      ? "text-accent-red"
      : tone === "warn"
        ? "text-accent-amber"
        : tone === "good"
          ? "text-accent-green"
          : "text-text-primary";
  return (
    <div className={`card px-4 py-3 ${toneClass}`}>
      <div className="text-[10px] text-text-muted uppercase tracking-[0.12em] mb-1.5">
        {label}
      </div>
      <div className={`text-xl font-mono font-semibold leading-none ${textClass}`}>
        {value}
      </div>
    </div>
  );
}

/** Dispute-flow ("cohort C") census badge. Rendered only when the run carries
 * the census (fresh scans; runs persisted before the field existed omit it).
 * `complete=false` escalates to a loud banner — a silent shrink of the
 * Official Ruling census is exactly what this field exists to prevent. */
function DisputeCoverageBadge({
  coverage,
}: {
  coverage: NonNullable<ScanRun["disputeCoverage"]>;
}) {
  if (coverage.complete) {
    return (
      <span
        className="chip chip-green normal-case tracking-normal"
        title={`Dispute-flow census complete: ${coverage.disputedCount} currently-disputed + ${coverage.replayCount} re-proposed (post-dispute) markets merged into this scan. The Official Ruling section saw the full cohort.`}
      >
        <span className="chip-dot" />
        Dispute census {coverage.disputedCount}+{coverage.replayCount} ✓
      </span>
    );
  }
  return (
    <span
      className="chip chip-amber normal-case tracking-normal"
      title="A backstop page failed during the dispute-flow census. The disputed/re-proposed counts are lower bounds and the Official Ruling section may be missing markets this run."
    >
      ⚠ Dispute census {coverage.disputedCount}+{coverage.replayCount} — incomplete
    </span>
  );
}

export function StatsBar({ scan }: { scan: ScanRun | null }) {
  if (!scan) {
    return (
      <div className="card px-5 py-6 text-center text-text-muted text-sm border-dashed">
        No scan data yet. Click{" "}
        <span className="text-text-secondary font-medium">Run Scan</span> to
        pull the live Polymarket book.
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

  const coverage = scan.disputeCoverage ?? null;

  return (
    <div className="space-y-2">
      {staleTone !== "neutral" && (
        <div
          className={`text-xs px-3 py-2 rounded-lg border ${
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

      {/* Incomplete dispute coverage is a data-integrity problem, not a
          footnote — banner treatment, same weight as staleness. */}
      {coverage && !coverage.complete && (
        <div className="text-xs px-3 py-2 rounded-lg border border-accent-amber/50 bg-accent-amber/10 text-accent-amber">
          Dispute-flow coverage incomplete — a backstop page failed this run.
          The Official Ruling census ({coverage.disputedCount} disputed +{" "}
          {coverage.replayCount} re-proposed) is a lower bound and may be
          missing markets.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Markets Scanned" value={scan.marketsScanned.toLocaleString()} />
        <StatCard label="Candidates" value={scan.candidatesFound} />
        <StatCard
          label="Actionable"
          value={scan.actionableCount}
          tone={scan.actionableCount > 0 ? "good" : "neutral"}
        />
        <StatCard label="Observe" value={scan.observeCount} />
        <StatCard label="Last Scan" value={timeAgo} tone={staleTone === "neutral" ? "neutral" : staleTone} />
      </div>

      {/* Run meta line: duration + dispute-flow census badge */}
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-text-muted px-0.5">
        <span className="font-mono">
          run {Math.round(scan.durationMs / 100) / 10}s
        </span>
        <span className="text-border-strong">·</span>
        <span className="font-mono">{scan.rejectedCount} rejected</span>
        {coverage && (
          <>
            <span className="text-border-strong">·</span>
            <DisputeCoverageBadge coverage={coverage} />
          </>
        )}
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
