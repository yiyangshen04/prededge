"use client";

/** Decision status → tone mapping. Single source of the status color system:
 * actionable=green, observe=amber, rejected=red. The dot + chip pairing is
 * what other status-ish chips (coverage, sweep) echo across the dashboard. */
const styles = {
  actionable: "chip chip-green",
  observe: "chip chip-amber",
  rejected: "chip chip-red",
} as const;

export function DecisionBadge({
  decision,
}: {
  decision: "actionable" | "observe" | "rejected";
}) {
  return (
    <span className={styles[decision]}>
      <span className="chip-dot" />
      {decision}
    </span>
  );
}
