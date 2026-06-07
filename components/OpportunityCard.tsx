"use client";

import { useState } from "react";
import type { Opportunity } from "@/lib/types";
import type { LiveMetrics } from "@/lib/liveRecompute";
import { DecisionBadge } from "./DecisionBadge";
import { TradeModal } from "./TradeModal";
import { isHiddenTag } from "@/lib/virtualTags";

/** Tags in `decision_reasons` that are informational (rendered as a badge
 * at the top of the card) rather than a downgrade cause. We strip them from
 * the "Decision reasons" chip strip at the bottom to avoid double-display. */
const INFO_REASON_TAGS = new Set(["rewards_incentivized", "model_backed"]);
/** UMA status prefix lives in `decision_reasons` as `oracle_proposed` /
 * `oracle_disputed`. Rendered as a top badge; hidden from the bottom strip. */
function isOracleReason(r: string): boolean {
  return r === "oracle_proposed" || r === "oracle_disputed";
}

function isOracleResetStalled(opp: Opportunity): boolean {
  return (
    opp.oracleResolutionState === "reset_stalled" ||
    opp.decisionReasons?.includes("oracle_reset_stalled") === true
  );
}

function isOracleSecondDispute(opp: Opportunity): boolean {
  return (
    opp.oracleResolutionState === "second_dispute" ||
    opp.decisionReasons?.includes("oracle_second_dispute") === true
  );
}

/** Compute expiry display from raw endDate for maximum precision */
function formatExpiry(
  endDate: string | null | undefined,
  awaitingResolution = false
): string {
  if (!endDate) return "N/A";
  const end = new Date(endDate);
  if (isNaN(end.getTime())) return "N/A";

  const diffMs = end.getTime() - Date.now();
  // "Awaiting" reads better than "Expired" for markets whose endDate has
  // passed but that are still accepting orders (arbitrageur-lag window).
  if (diffMs <= 0) return awaitingResolution ? "Awaiting" : "Expired";

  const totalMins = diffMs / (1000 * 60);
  const totalHrs = totalMins / 60;
  const totalDays = totalHrs / 24;

  if (totalMins < 60) {
    return `${Math.round(totalMins)}m`;
  }
  if (totalHrs < 24) {
    const h = Math.floor(totalHrs);
    const m = Math.round(totalHrs % 1 * 60);
    return `${h}h ${m}m`;
  }
  if (totalDays < 7) {
    const d = Math.floor(totalDays);
    const h = Math.round((totalDays - d) * 24);
    return `${d}d ${h}h`;
  }
  return `${Math.round(totalDays)}d`;
}

function sameTiming(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const at = new Date(a).getTime();
  const bt = new Date(b).getTime();
  return !isNaN(at) && !isNaN(bt) && Math.abs(at - bt) < 60_000;
}

interface OpportunityCardProps {
  opp: Opportunity;
  /** Size-adjusted metrics; card falls back to stored values if absent. */
  live?: LiveMetrics;
  /** User-selected trade size in USD (for display/badging). */
  tradeSizeUsd?: number;
}

export function OpportunityCard({
  opp,
  live,
  tradeSizeUsd,
}: OpportunityCardProps) {
  const [tradeOutcome, setTradeOutcome] = useState<string | null>(null);

  // Prefer size-adjusted numbers when available; fall back to the scanner's
  // $200 baseline for older rows that predate the asks-snapshot migration.
  const shownAnnualizedYield = live?.annualizedYieldPct ?? opp.annualizedYieldPct;
  const shownNetReturn = live?.netReturnPct ?? opp.netReturnPct;
  const shownSlippageBps = live?.slippageBps ?? opp.slippageBps;
  const shownPrice = live?.avgFillPrice ?? opp.price;

  const yieldColor =
    shownAnnualizedYield >= 50
      ? "text-accent-green"
      : shownAnnualizedYield >= 20
        ? "text-accent-amber"
        : "text-text-secondary";

  // Show the $200-baseline yield as a subscript so the user sees the size
  // decay when they raise the trade size above the scanner baseline.
  const showBaseline =
    live != null &&
    tradeSizeUsd != null &&
    tradeSizeUsd !== 200 &&
    Math.abs(opp.annualizedYieldPct - shownAnnualizedYield) > 0.5;

  // Build ordered list of tradable outcomes (Yes first if present, else alphabetical)
  const outcomeTokens = opp.outcomeTokens ?? {};
  const outcomeEntries = Object.entries(outcomeTokens).sort(([a], [b]) => {
    if (a.toLowerCase() === "yes") return -1;
    if (b.toLowerCase() === "yes") return 1;
    if (a.toLowerCase() === "no") return 1;
    if (b.toLowerCase() === "no") return -1;
    return a.localeCompare(b);
  });

  /** Approximate price for a given outcome name (real price fetched at trade time).
   * Uses the size-adjusted `shownPrice` so the CTA stays in sync with the
   * "Avg Fill" metric when the user raises trade size above the baseline. */
  const approxPrice = (outcome: string): number => {
    if (outcome === opp.outcome) return shownPrice;
    // Binary fallback: other side = 1 - tail
    if (outcomeEntries.length === 2) return 1 - shownPrice;
    // Multi-outcome: we don't know, just show 1 - tail as rough approximation
    return 1 - shownPrice;
  };

  const buttonStyle = (outcome: string): string => {
    const lower = outcome.toLowerCase();
    if (lower === "yes") {
      return "bg-accent-green/10 text-accent-green border border-accent-green/30 hover:bg-accent-green/20";
    }
    if (lower === "no") {
      return "bg-accent-red/10 text-accent-red border border-accent-red/30 hover:bg-accent-red/20";
    }
    return "bg-accent-blue/10 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/20";
  };

  return (
    <div className="bg-bg-card border border-border rounded-lg p-4 hover:border-accent-blue/40 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-text-primary leading-tight line-clamp-2">
            {opp.question}
          </h3>
          {opp.eventTitle && opp.eventTitle !== opp.question && (
            <div
              title="Parent event on Polymarket. Clicking through opens the event hub, which contains this market and other sibling sub-questions."
              className="text-[11px] text-text-muted mt-0.5 truncate"
            >
              ↳ {opp.eventTitle}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
          {/* Badges derive from either the in-memory Opportunity fields (fresh
              POST /api/scan responses carry them) OR the decision_reasons
              persisted list (the compatibility channel that works across
              storage schemas). `oracleReason` prefix-matches
              `oracle_proposed` / `oracle_disputed` coming through reasons. */}
          {(() => {
            const oracleReason = opp.decisionReasons?.find(isOracleReason);
            const normalizedUma = opp.umaResolutionStatus?.trim();
            const resetStalled = isOracleResetStalled(opp);
            const secondDispute = isOracleSecondDispute(opp);
            const uma =
              normalizedUma && normalizedUma.toLowerCase() !== "none"
                ? normalizedUma
                : oracleReason
                  ? oracleReason.replace(/^oracle_/, "")
                  : null;
            return uma ? (
              <span
                title={
                  secondDispute
                    ? "Re-proposal after the first dispute was disputed again — question has been escalated to UMA DVM full vote (48-72h)."
                    : resetStalled
                      ? "Gamma reports this market as disputed, but chain state shows the adapter request was reset and no active UMA proposal is currently live."
                      : "Gamma reports this market in UMA oracle resolution flow."
                }
                className="text-[10px] px-1.5 py-0.5 rounded bg-accent-red/15 text-accent-red border border-accent-red/30 uppercase tracking-wider"
              >
                Oracle {uma}
              </span>
            ) : null;
          })()}
          {isOracleResetStalled(opp) && (
            <span
              title={
                opp.oracleResolutionDetails ??
                "First UMA dispute reset this market's adapter request, but the current request has no active proposal and no available price."
              }
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-amber/15 text-accent-amber border border-accent-amber/30 uppercase tracking-wider"
            >
              Oracle Reset
            </span>
          )}
          {isOracleSecondDispute(opp) && (
            <span
              title={
                opp.oracleResolutionDetails ??
                "Adapter was reset by the first dispute, the re-proposed price was disputed again, and the question is now in UMA DVM full-vote (48-72h). Outcome is no longer locally inferable."
              }
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-amber/15 text-accent-amber border border-accent-amber/30 uppercase tracking-wider"
            >
              Second Dispute
            </span>
          )}
          {(opp.rewardsIncentivized ||
            opp.decisionReasons?.includes("rewards_incentivized")) && (
            <span
              title="Polymarket liquidity-rewards program active — top of book is bot-maintained. You can still fill, but the price isn't a mispricing."
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-blue/15 text-accent-blue border border-accent-blue/30 uppercase tracking-wider"
            >
              Rewards
            </span>
          )}
          {(opp.negRisk ||
            opp.decisionReasons?.includes("neg_risk_bucket")) && (
            <span
              title="Multi-outcome (negRisk) market — this is one of many mutually-exclusive buckets; a ~0.95 No is a mathematical tail, not a mispricing"
              className="text-[10px] px-1.5 py-0.5 rounded bg-text-muted/15 text-text-muted border border-text-muted/30 uppercase tracking-wider"
            >
              Multi
            </span>
          )}
          {(() => {
            // Sports non-moneyline markets: spreads/totals/child_moneyline.
            // The outcome labels read like team-win bets but the price
            // includes the spread/total compensation, so the ~0.97 ask does
            // NOT equal the team's win probability.
            const sportsReason = opp.decisionReasons?.find((r) =>
              r.startsWith("sports_")
            );
            const smt =
              opp.sportsMarketType && opp.sportsMarketType !== "moneyline"
                ? opp.sportsMarketType
                : sportsReason
                  ? sportsReason.replace(/^sports_/, "")
                  : null;
            if (!smt) return null;
            const label =
              smt === "spreads"
                ? "Spread"
                : smt === "totals"
                  ? "Totals"
                  : smt.replace(/_/g, " ");
            return (
              <span
                title="Non-moneyline sports wager — outcome labels are team/side names but the price includes point-spread or over/under compensation. Not a moneyline probability."
                className="text-[10px] px-1.5 py-0.5 rounded bg-accent-amber/15 text-accent-amber border border-accent-amber/30 uppercase tracking-wider"
              >
                {label}
              </span>
            );
          })()}
          {(() => {
            // Kickoff-driven book clear. `clearBookOnStart` fires at
            // `gameStartTime`, so:
            //  - in-play (gameStartTime in the past): book cycles faster
            //    than our scan cadence → stale snapshot → observe badge.
            //  - future kickoff < 60 min: not filtered by scanner (we only
            //    hard-skip <15 min), but we surface the countdown so the
            //    user knows the snapshot has a hard expiry.
            const isInPlayReason =
              opp.decisionReasons?.includes("in_play") === true;
            const gst = opp.gameStartTime;
            if (!gst && !isInPlayReason) return null;
            const t = gst ? new Date(gst).getTime() : NaN;
            const mins = !isNaN(t) ? (t - new Date().getTime()) / 60_000 : null;
            if (isInPlayReason || (mins != null && mins <= 0)) {
              return (
                <span
                  title="gameStartTime has passed — sports are in-play, or a snapshot market's observation window is open. The ask price tracks live data (score, temp, tweet count) and drifts faster than our scan cadence, so this snapshot is stale within minutes."
                  className="text-[10px] px-1.5 py-0.5 rounded bg-accent-red/15 text-accent-red border border-accent-red/30 uppercase tracking-wider"
                >
                  In-play
                </span>
              );
            }
            if (mins != null && mins < 60) {
              const label =
                mins < 60 ? `Kicks in ${Math.ceil(mins)}m` : `Kicks in ${Math.round(mins / 60)}h`;
              return (
                <span
                  title="gameStartTime is imminent. Once it passes, the ask will start tracking live data (game score / observation-window measurements) and this snapshot depth will drift."
                  className="text-[10px] px-1.5 py-0.5 rounded bg-accent-amber/15 text-accent-amber border border-accent-amber/30 uppercase tracking-wider"
                >
                  {label}
                </span>
              );
            }
            return null;
          })()}
          {opp.staleRawEndDate && (
            <span
              title="Gamma endDate looked stale, so the scanner used the title/rules/lifecycle data to infer the current event cutoff."
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-green/15 text-accent-green border border-accent-green/30 uppercase tracking-wider"
            >
              Corrected
            </span>
          )}
          {opp.recurrentLike && !opp.postponed && (
            <span
              title="Recurring or rolled-forward market. The displayed event cutoff is inferred from the current cycle rather than the stale raw Gamma endDate."
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-blue/15 text-accent-blue border border-accent-blue/30 uppercase tracking-wider"
            >
              Recurrent
            </span>
          )}
          {opp.postponed && (
            <span
              title="Original event date moved after Gamma's raw endDate. Treat this as rescheduled/open rather than awaiting resolution."
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-amber/15 text-accent-amber border border-accent-amber/30 uppercase tracking-wider"
            >
              Rescheduled
            </span>
          )}
          {opp.awaitingResolution && (
            <span
              title="Inferred event cutoff has passed, market is still accepting orders, and the book price is highly converged."
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-amber/15 text-accent-amber border border-accent-amber/30 uppercase tracking-wider"
            >
              Awaiting
            </span>
          )}
          {opp.modelOverlay && (
            <span
              title={`Saylor BTC-weekly model fair value for this outcome: ${(
                opp.modelOverlay.fairValue * 100
              ).toFixed(0)}% (model P(YES) = ${(
                opp.modelOverlay.fairValueYes * 100
              ).toFixed(0)}%). The scanner has no probability model of its own; this is the one market where the Saylor predictor supplies a fair value.`}
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-blue/15 text-accent-blue border border-accent-blue/30 uppercase tracking-wider"
            >
              Model
            </span>
          )}
          <DecisionBadge decision={opp.decision} />
        </div>
      </div>

      {/* Key metrics grid */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        <MetricCell
          label={live ? "Avg Fill" : "Buy Price"}
          value={shownPrice.toFixed(3)}
          mono
        />
        <MetricCell
          label="Ann. Yield"
          value={`${shownAnnualizedYield.toFixed(1)}%`}
          className={yieldColor}
          mono
          sub={
            showBaseline
              ? `baseline @ $200: ${opp.annualizedYieldPct.toFixed(1)}%`
              : undefined
          }
        />
        <MetricCell
          label="Net Return"
          value={`${(shownNetReturn * 100).toFixed(2)}%`}
          mono
        />
      </div>

      <div className="grid grid-cols-4 gap-3 mb-3">
        {(() => {
          const eventDeadline = opp.eventDeadline ?? opp.endDate;
          const payoutDeadline =
            opp.expectedPayoutDate ?? opp.resolutionDeadline ?? eventDeadline;
          const showPayout =
            payoutDeadline != null && !sameTiming(payoutDeadline, eventDeadline);
          const showRaw =
            opp.staleRawEndDate &&
            opp.endDate != null &&
            !sameTiming(opp.endDate, eventDeadline);
          const sub = showPayout
            ? `settle ${formatExpiry(payoutDeadline)}`
            : showRaw
              ? `gamma ${formatExpiry(opp.endDate)}`
              : undefined;
          return (
            <MetricCell
              label="Event"
              value={formatExpiry(eventDeadline, opp.awaitingResolution)}
              mono
              sub={sub}
            />
          );
        })()}
        <MetricCell
          label="Depth (USD)"
          value={`$${opp.nearDepthUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          mono
        />
        <MetricCell
          label="Slippage"
          value={shownSlippageBps > 999 ? "N/A" : `${shownSlippageBps.toFixed(1)} bps`}
          mono
        />
        <MetricCell
          label="Score"
          value={`${opp.stabilityScore}/100`}
          mono
        />
      </div>

      {/* Saylor model fair-value overlay. The scanner ranks tail prices but
          has no view on true probability; for the MSTR weekly market the Saylor
          predictor supplies one, turning the bare ask into a model-vs-market
          edge. A materially richer market demotes the card to "observe". */}
      {opp.modelOverlay && (() => {
        const m = opp.modelOverlay;
        const edgePositive = m.edgePp >= 0;
        const contradicts = opp.decisionReasons.includes(
          "model_contradicts_market"
        );
        return (
          <div className="mb-3 rounded border border-accent-blue/30 bg-accent-blue/5 px-3 py-2">
            <div className="flex items-center justify-between gap-2 flex-wrap text-[11px]">
              <span className="uppercase tracking-wider text-text-muted">
                Saylor model
              </span>
              <div className="flex items-center gap-2.5 font-mono">
                <span className="text-text-secondary">
                  fair{" "}
                  <span className="text-text-primary">
                    {(m.fairValue * 100).toFixed(0)}%
                  </span>
                </span>
                <span className="text-text-muted">vs</span>
                <span className="text-text-secondary">
                  mkt{" "}
                  <span className="text-text-primary">
                    {(opp.price * 100).toFixed(0)}%
                  </span>
                </span>
                <span
                  className={
                    edgePositive ? "text-accent-green" : "text-accent-red"
                  }
                >
                  {edgePositive ? "+" : ""}
                  {m.edgePp.toFixed(1)}pp
                </span>
                <span className="px-1.5 py-0.5 rounded bg-bg-input border border-border uppercase tracking-wider text-text-secondary">
                  {m.recommendation}
                </span>
              </div>
            </div>
            <div className="text-[10px] text-text-muted mt-1">
              {contradicts
                ? "Market prices this outcome above the model's fair value — tail demoted to observe."
                : `model signal: ${m.reason}`}
            </div>
          </div>
        );
      })()}

      {live?.bookDrained && tradeSizeUsd != null && (
        <div className="mb-3 text-[11px] text-accent-amber bg-accent-amber/10 border border-accent-amber/30 rounded px-2 py-1">
          ⚠ Book drained at ${tradeSizeUsd.toLocaleString()} — only $
          {live.investedUsd.toFixed(2)} would fill from the stored snapshot.
          Yield shown reflects the filled amount only.
        </div>
      )}

      {/* Trade buttons */}
      {outcomeEntries.length > 0 && (
        <div className="flex gap-2 mb-3">
          {outcomeEntries.map(([outcome]) => (
            <button
              key={outcome}
              onClick={() => setTradeOutcome(outcome)}
              className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${buttonStyle(outcome)}`}
            >
              Buy {outcome.toUpperCase()} @ ${approxPrice(outcome).toFixed(3)}
            </button>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>
          {opp.outcome} &middot; Vol ${opp.volume24hr.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>
        <a
          href={opp.marketUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-blue hover:underline"
        >
          View on Polymarket &rarr;
        </a>
      </div>

      {/* Tags */}
      {opp.tags && opp.tags.filter((t) => !isHiddenTag(t)).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {opp.tags
            .filter((t) => !isHiddenTag(t))
            .slice(0, 5)
            .map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded bg-accent-blue/10 text-accent-blue border border-accent-blue/20"
              >
                {tag}
              </span>
            ))}
        </div>
      )}

      {/* Decision reasons — excludes informational tags (rewards, neg_risk,
          oracle_*) that already render as badges at the top of the card and
          the encoded `deadline:ISO` metadata which feeds the Expiry cell. */}
      {(() => {
        const shown = opp.decisionReasons.filter(
          (r) =>
            !INFO_REASON_TAGS.has(r) &&
            r !== "neg_risk_bucket" &&
            r !== "in_play" &&
            !isOracleReason(r) &&
            r !== "oracle_reset_stalled" &&
            r !== "oracle_second_dispute" &&
            !r.startsWith("deadline:") &&
            !r.startsWith("sports_") &&
            r !== "model_contradicts_market"
        );
        if (shown.length === 0) return null;
        return (
          <div className="mt-2 flex flex-wrap gap-1">
            {shown.map((r) => (
              <span
                key={r}
                className="text-[10px] px-1.5 py-0.5 rounded bg-bg-primary text-text-muted border border-border"
              >
                {r}
              </span>
            ))}
          </div>
        );
      })()}

      {/* Trade modal */}
      {tradeOutcome && (
        <TradeModal
          opportunity={opp}
          side={
            tradeOutcome.toLowerCase() === "yes"
              ? "YES"
              : tradeOutcome.toLowerCase() === "no"
                ? "NO"
                : "YES"
          }
          outcomeName={tradeOutcome}
          tokenId={outcomeTokens[tradeOutcome]}
          onClose={() => setTradeOutcome(null)}
          onConfirmed={() => setTradeOutcome(null)}
        />
      )}
    </div>
  );
}

function MetricCell({
  label,
  value,
  className = "",
  mono = false,
  sub,
}: {
  label: string;
  value: string;
  className?: string;
  mono?: boolean;
  sub?: string;
}) {
  return (
    <div>
      <div className="text-[10px] text-text-muted uppercase tracking-wider">
        {label}
      </div>
      <div
        className={`text-sm ${mono ? "font-mono" : ""} ${className || "text-text-primary"}`}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[9px] text-text-muted font-mono mt-0.5">{sub}</div>
      )}
    </div>
  );
}
