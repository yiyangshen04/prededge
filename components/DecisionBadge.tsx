"use client";

const styles = {
  actionable: "bg-accent-green-dim text-accent-green",
  observe: "bg-accent-amber-dim text-accent-amber",
  rejected: "bg-accent-red-dim text-accent-red",
} as const;

export function DecisionBadge({
  decision,
}: {
  decision: "actionable" | "observe" | "rejected";
}) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wider ${styles[decision]}`}
    >
      {decision}
    </span>
  );
}
