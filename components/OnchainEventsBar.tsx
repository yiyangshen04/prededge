"use client";

import type { ScanResponse } from "@/lib/types";

type OnchainEvents = NonNullable<ScanResponse["onchainEvents"]>;

/** Summary strip for the incremental on-chain event sweep (what happened
 * between the previous scan and this one). Three states:
 *  - `undefined` → field absent: the visible run was loaded from the DB
 *    (sweep results aren't persisted) → render nothing;
 *  - `null` → the sweep ran but the RPC was unavailable → explicit warning,
 *    distinct from "no events";
 *  - object → counts + any markets discovered outside the scan surface. */
export function OnchainEventsBar({
  events,
}: {
  events: ScanResponse["onchainEvents"] | undefined;
}) {
  if (events === undefined) return null;

  if (events === null) {
    return (
      <div className="card px-4 py-2.5 border-accent-amber/40 bg-accent-amber/5">
        <div className="flex items-center gap-2 text-xs text-accent-amber">
          <span className="chip chip-amber shrink-0">
            <span className="chip-dot" />
            Chain sweep offline
          </span>
          <span className="text-text-secondary">
            RPC unavailable this run — on-chain dispute resets and official
            context updates since the last scan could not be checked.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="card px-4 py-3 space-y-2.5">
      {/* Headline counts */}
      <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap text-xs">
        <span className="text-[10px] uppercase tracking-[0.12em] text-text-muted shrink-0">
          Since last scan
        </span>
        <span
          className="font-mono text-text-muted"
          title="Block range swept for QuestionReset / AncillaryDataUpdated events"
        >
          blocks {events.fromBlock.toLocaleString()}–{events.toBlock.toLocaleString()}
        </span>
        <span className="text-border-strong">·</span>
        <Count
          n={events.resetCount}
          label={`dispute reset${events.resetCount === 1 ? "" : "s"}`}
          tone="red"
          title="QuestionReset events on-chain — a dispute wiped the adapter request and the market re-entered the proposal flow."
        />
        <span className="text-border-strong">·</span>
        <Count
          n={events.contextUpdateCount}
          label={`official context update${events.contextUpdateCount === 1 ? "" : "s"}`}
          tone="green"
          title="AncillaryDataUpdated events — Polymarket officials posted or amended on-chain additional context."
        />
        <span className="text-border-strong">·</span>
        <Count
          n={events.knownHits}
          label="on scanned markets"
          tone="blue"
          title="Events whose question id matched a market already inside this scan's surface."
        />
        {events.incomplete && (
          <span
            className="chip chip-amber"
            title="Some block ranges failed during the sweep — the counts above are lower bounds, not the full picture."
          >
            ⚠ sweep incomplete
          </span>
        )}
      </div>

      {/* Markets the sweep found outside the scan surface */}
      {events.discovered.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-[0.12em] text-accent-gold">
            {events.discovered.length} market
            {events.discovered.length === 1 ? "" : "s"} found outside the scan
            surface
          </div>
          <ul className="space-y-1">
            {events.discovered.map((d) => (
              <li
                key={`${d.conditionId}-${d.slug}`}
                className="flex items-center gap-2 flex-wrap text-xs"
              >
                <a
                  href={`https://polymarket.com/market/${d.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-text-primary hover:text-accent-blue transition-colors truncate max-w-[32rem]"
                  title={d.question}
                >
                  {d.question}
                </a>
                <span className="chip chip-neutral">
                  {d.umaResolutionStatus ?? "status unknown"}
                </span>
                {d.via.map((v) => (
                  <span
                    key={v}
                    className={v === "reset" ? "chip chip-red" : "chip chip-green"}
                    title={
                      v === "reset"
                        ? "Discovered via a QuestionReset event"
                        : "Discovered via an AncillaryDataUpdated (official context) event"
                    }
                  >
                    via {v}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Unmatched question ids — events we saw but couldn't map to a market */}
      {events.unmatchedQuestionIds.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-text-muted hover:text-text-secondary transition-colors select-none">
            {events.unmatchedQuestionIds.length} unmatched question id
            {events.unmatchedQuestionIds.length === 1 ? "" : "s"} (event seen
            on-chain, no Gamma market resolved)
          </summary>
          <ul className="mt-1.5 space-y-0.5 font-mono text-[10px] text-text-muted break-all">
            {events.unmatchedQuestionIds.map((qid) => (
              <li key={qid}>{qid}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Count({
  n,
  label,
  tone,
  title,
}: {
  n: number;
  label: string;
  tone: "red" | "green" | "blue";
  title: string;
}) {
  const toneClass =
    n === 0
      ? "text-text-muted"
      : tone === "red"
        ? "text-accent-red"
        : tone === "green"
          ? "text-accent-green"
          : "text-accent-blue";
  return (
    <span className="inline-flex items-baseline gap-1" title={title}>
      <span className={`font-mono font-semibold ${toneClass}`}>{n}</span>
      <span className="text-text-secondary">{label}</span>
    </span>
  );
}
