"use client";

import { useState } from "react";
import type { Opportunity } from "@/lib/types";
import type { LiveMetrics } from "@/lib/liveRecompute";
import { DecisionBadge } from "./DecisionBadge";
import { TradeModal } from "./TradeModal";
import { isDirectionalStance, isHiddenTag } from "@/lib/virtualTags";

/** Tags in `decision_reasons` that are informational (rendered as a badge
 * at the top of the card) rather than a downgrade cause. We strip them from
 * the "Decision reasons" chip strip at the bottom to avoid double-display. */
const INFO_REASON_TAGS = new Set([
  "rewards_incentivized",
  "model_backed",
  "official_direction_backed",
  "official_divergence_play",
  "divergence_leg_needs_text_backing",
]);
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

/** Divergence-leg detection. `divergenceLeg` isn't persisted to the DB, so
 * rows loaded via GET must be recognized through the decision_reasons channel
 * (the same compatibility trick the oracle badges use). */
export function isDivergencePlay(opp: Opportunity): boolean {
  return opp.decisionReasons?.includes("official_divergence_play") === true;
}
export function isDivergenceUnbacked(opp: Opportunity): boolean {
  return (
    opp.decisionReasons?.includes("divergence_leg_needs_text_backing") === true
  );
}
export function isDivergenceLegOpp(opp: Opportunity): boolean {
  return (
    opp.divergenceLeg === true ||
    isDivergencePlay(opp) ||
    isDivergenceUnbacked(opp)
  );
}

/** Badge label for a directional official stance; null for the rest. */
function officialStanceLabel(stance: string): string | null {
  if (stance === "YES" || stance === "NO") return `Official → ${stance}`;
  if (stance === "leans_YES") return "Official ≈ YES";
  if (stance === "leans_NO") return "Official ≈ NO";
  if (stance.startsWith("resolve_to_")) {
    const target = stance.slice("resolve_to_".length).replace(/_/g, " ");
    return `Official → ${target.toUpperCase()}`;
  }
  return null;
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

/** Unified card badge: one chip family, tone picks the accent. */
function Chip({
  tone,
  title,
  children,
}: {
  tone: "green" | "amber" | "red" | "blue" | "gold" | "neutral";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span title={title} className={`chip chip-${tone}`}>
      {children}
    </span>
  );
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

  const divergencePlay = isDivergencePlay(opp);
  const divergenceUnbacked = isDivergenceUnbacked(opp);

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
      return "bg-accent-green/10 text-accent-green border border-accent-green/30 hover:bg-accent-green/20 hover:border-accent-green/50";
    }
    if (lower === "no") {
      return "bg-accent-red/10 text-accent-red border border-accent-red/30 hover:bg-accent-red/20 hover:border-accent-red/50";
    }
    return "bg-accent-blue/10 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/20 hover:border-accent-blue/50";
  };

  return (
    <div
      className={`card card-hover p-4 ${divergencePlay ? "card-divergence" : ""}`}
    >
      {/* Header. flex-wrap + basis on the title lets a badge-heavy dispute
          card drop its chip cluster to a second line instead of squeezing
          the question out of view on narrow screens. */}
      <div className="flex items-start justify-between gap-x-3 gap-y-1.5 mb-3 flex-wrap">
        <div className="flex-1 min-w-0 basis-56">
          <h3 className="text-sm font-medium text-text-primary leading-snug line-clamp-2">
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
        <div className="flex items-center gap-1.5 flex-wrap justify-end max-w-full">
          {/* Badges derive from either the in-memory Opportunity fields (fresh
              POST /api/scan responses carry them) OR the decision_reasons
              persisted list (the compatibility channel that works across
              storage schemas). `oracleReason` prefix-matches
              `oracle_proposed` / `oracle_disputed` coming through reasons. */}
          {divergencePlay && (
            <Chip
              tone="gold"
              title="Site-wide top-priority signal: this is the trailing (<0.5) leg of a disputed market AND a high-confidence official TEXT stance backs this side. Historically official-direction calls settled 32/32 the official way."
            >
              ★ Divergence Play
            </Chip>
          )}
          {divergenceUnbacked && (
            <Chip
              tone="neutral"
              title="Trailing (<0.5) leg of a disputed market whose payoff depends on the ruling landing this way — but no high-confidence official text backs this side, so it is capped at observe. Not actionable until officials write a directional context."
            >
              Divergence · unbacked
            </Chip>
          )}
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
              <Chip
                tone="red"
                title={
                  secondDispute
                    ? "Re-proposal after the first dispute was disputed again — question has been escalated to UMA DVM full vote (48-72h)."
                    : resetStalled
                      ? "Gamma reports this market as disputed, but chain state shows the adapter request was reset and no active UMA proposal is currently live."
                      : "Gamma reports this market in UMA oracle resolution flow."
                }
              >
                Oracle {uma}
              </Chip>
            ) : null;
          })()}
          {isOracleResetStalled(opp) && (
            <Chip
              tone="amber"
              title={
                opp.oracleResolutionDetails ??
                "First UMA dispute reset this market's adapter request, but the current request has no active proposal and no available price."
              }
            >
              Oracle Reset
            </Chip>
          )}
          {isOracleSecondDispute(opp) && (
            <Chip
              tone="amber"
              title={
                opp.oracleResolutionDetails ??
                "Adapter was reset by the first dispute, the re-proposed price was disputed again, and the question is now in UMA DVM full-vote (48-72h). Outcome is no longer locally inferable."
              }
            >
              Second Dispute
            </Chip>
          )}
          {opp.officialContext &&
            isDirectionalStance(opp.officialContext.stance) &&
            officialStanceLabel(opp.officialContext.stance) && (
              <Chip
                tone="green"
                title={
                  opp.officialContext.via === "price_fallback"
                    ? "Direction inferred from the extreme price of an already-disputed market — no explicit official text. Weight it lower than a written ruling."
                    : "Polymarket officials wrote an on-chain additional-context note implying this resolution direction. Historically 32/32 such calls settled the official way."
                }
              >
                {officialStanceLabel(opp.officialContext.stance)}
              </Chip>
            )}
          {opp.officialContext?.refundClause && (
            <Chip
              tone="amber"
              title="The official context mentions refunding losing positions (or a 50/50 split). The opposing side then carries no real risk and the spread is not edge."
            >
              Refund Risk
            </Chip>
          )}
          {(opp.rewardsIncentivized ||
            opp.decisionReasons?.includes("rewards_incentivized")) && (
            <Chip
              tone="blue"
              title="Polymarket liquidity-rewards program active — top of book is bot-maintained. You can still fill, but the price isn't a mispricing."
            >
              Rewards
            </Chip>
          )}
          {(opp.negRisk ||
            opp.decisionReasons?.includes("neg_risk_bucket")) && (
            <Chip
              tone="neutral"
              title="Multi-outcome (negRisk) market — this is one of many mutually-exclusive buckets; a ~0.95 No is a mathematical tail, not a mispricing"
            >
              Multi
            </Chip>
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
              <Chip
                tone="amber"
                title="Non-moneyline sports wager — outcome labels are team/side names but the price includes point-spread or over/under compensation. Not a moneyline probability."
              >
                {label}
              </Chip>
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
                <Chip
                  tone="red"
                  title="gameStartTime has passed — sports are in-play, or a snapshot market's observation window is open. The ask price tracks live data (score, temp, tweet count) and drifts faster than our scan cadence, so this snapshot is stale within minutes."
                >
                  In-play
                </Chip>
              );
            }
            if (mins != null && mins < 60) {
              const label =
                mins < 60 ? `Kicks in ${Math.ceil(mins)}m` : `Kicks in ${Math.round(mins / 60)}h`;
              return (
                <Chip
                  tone="amber"
                  title="gameStartTime is imminent. Once it passes, the ask will start tracking live data (game score / observation-window measurements) and this snapshot depth will drift."
                >
                  {label}
                </Chip>
              );
            }
            return null;
          })()}
          {opp.staleRawEndDate && (
            <Chip
              tone="green"
              title="Gamma endDate looked stale, so the scanner used the title/rules/lifecycle data to infer the current event cutoff."
            >
              Corrected
            </Chip>
          )}
          {opp.recurrentLike && !opp.postponed && (
            <Chip
              tone="blue"
              title="Recurring or rolled-forward market. The displayed event cutoff is inferred from the current cycle rather than the stale raw Gamma endDate."
            >
              Recurrent
            </Chip>
          )}
          {opp.postponed && (
            <Chip
              tone="amber"
              title="Original event date moved after Gamma's raw endDate. Treat this as rescheduled/open rather than awaiting resolution."
            >
              Rescheduled
            </Chip>
          )}
          {opp.awaitingResolution && (
            <Chip
              tone="amber"
              title="Inferred event cutoff has passed, market is still accepting orders, and the book price is highly converged."
            >
              Awaiting
            </Chip>
          )}
          {opp.modelOverlay && (
            <Chip
              tone="blue"
              title={`Saylor BTC-weekly model fair value for this outcome: ${(
                opp.modelOverlay.fairValue * 100
              ).toFixed(0)}% (model P(YES) = ${(
                opp.modelOverlay.fairValueYes * 100
              ).toFixed(0)}%). The scanner has no probability model of its own; this is the one market where the Saylor predictor supplies a fair value.`}
            >
              Model
            </Chip>
          )}
          <DecisionBadge decision={opp.decision} />
        </div>
      </div>

      {/* Divergence-play spotlight: official stance vs. market price and the
          payout multiple if the ruling lands. This is the highest-priority
          signal on the site, so it gets its own gold block above the metric
          grid rather than a footnote. */}
      {divergencePlay && opp.officialContext && (
        <div className="mb-3 rounded-lg border border-accent-gold/40 bg-accent-gold/10 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="uppercase tracking-[0.12em] font-semibold text-accent-gold">
                Divergence Play
              </span>
              <span className="text-text-secondary">
                official text backs this trailing leg
              </span>
            </div>
            <div className="flex items-center gap-2.5 font-mono text-xs">
              <span
                className="text-text-primary font-semibold"
                title="Official on-chain stance and classifier confidence"
              >
                {opp.officialContext.stance}
                <span className="text-text-muted font-normal">
                  {" "}
                  · {opp.officialContext.confidence} ({opp.officialContext.via})
                </span>
              </span>
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-2.5 font-mono text-sm flex-wrap">
            <span className="text-text-secondary text-xs">market prices it</span>
            <span className="text-text-primary font-semibold">
              {(shownPrice * 100).toFixed(1)}¢
            </span>
            <span className="text-text-muted text-xs">→</span>
            <span
              className="text-accent-gold font-bold"
              title={`Payout multiple if the official direction lands: 1 / ${shownPrice.toFixed(3)}`}
            >
              {shownPrice > 0 ? (1 / shownPrice).toFixed(1) : "—"}× payout
            </span>
            <span className="text-text-muted text-[11px]">
              if the ruling lands
            </span>
          </div>
        </div>
      )}

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
          emphasize
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

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
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
          <div className="mb-3 rounded-lg border border-accent-blue/30 bg-accent-blue/5 px-3 py-2">
            <div className="flex items-center justify-between gap-2 flex-wrap text-[11px]">
              <span className="uppercase tracking-[0.12em] text-text-muted">
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
                <span className="chip chip-neutral">{m.recommendation}</span>
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

      {/* Official additional-context block. The on-chain context text is not
          exposed by Gamma, so this is the only place the user sees what the
          officials actually wrote and which way it points. */}
      {opp.officialContext && (() => {
        const oc = opp.officialContext;
        const contradicts = opp.decisionReasons.includes(
          "official_contradicts_side"
        );
        return (
          <div className="mb-3 rounded-lg border border-accent-green/30 bg-accent-green/5 px-3 py-2">
            <div className="flex items-center justify-between gap-2 flex-wrap text-[11px]">
              <span className="uppercase tracking-[0.12em] text-text-muted">
                Official context
              </span>
              <div className="flex items-center gap-2.5 font-mono">
                <span className="text-text-primary">{oc.stance}</span>
                <span className="chip chip-neutral">
                  {oc.via === "price_fallback" ? "price fallback" : oc.confidence}
                </span>
                {oc.updateCount > 0 && (
                  <span className="text-text-muted">
                    {oc.updateCount} update{oc.updateCount === 1 ? "" : "s"}
                    {oc.lastUpdateAt
                      ? ` · ${new Date(oc.lastUpdateAt).toLocaleDateString()}`
                      : ""}
                  </span>
                )}
              </div>
            </div>
            {oc.excerpt && (
              <div className="text-[10px] text-text-secondary mt-1 line-clamp-3">
                “{oc.excerpt}”
              </div>
            )}
            {(contradicts || oc.refundClause) && (
              <div className="text-[10px] mt-1">
                {contradicts && (
                  <span className="text-accent-red">
                    Officials implied the opposite side — never buy against the
                    ruling.{" "}
                  </span>
                )}
                {oc.refundClause && (
                  <span className="text-accent-amber">
                    Refund clause present — the spread is not a real risk
                    transfer.
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {live?.bookDrained && tradeSizeUsd != null && (
        <div className="mb-3 text-[11px] text-accent-amber bg-accent-amber/10 border border-accent-amber/30 rounded-lg px-2.5 py-1.5">
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
              className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium font-mono transition-colors ${buttonStyle(outcome)}`}
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
          className="text-accent-blue hover:underline underline-offset-2"
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
                className="text-[10px] px-1.5 py-0.5 rounded-md bg-accent-blue/10 text-accent-blue border border-accent-blue/20"
              >
                {tag}
              </span>
            ))}
        </div>
      )}

      {/* Decision reasons — excludes informational tags (rewards, neg_risk,
          oracle_*, divergence_*) that already render as badges at the top of
          the card and the encoded `deadline:ISO` metadata which feeds the
          Expiry cell. */}
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
            r !== "model_contradicts_market" &&
            r !== "official_contradicts_side" &&
            r !== "refund_clause"
        );
        if (shown.length === 0) return null;
        return (
          <div className="mt-2 flex flex-wrap gap-1">
            {shown.map((r) => (
              <span key={r} className="chip chip-neutral normal-case tracking-normal">
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
  emphasize = false,
  sub,
}: {
  label: string;
  value: string;
  className?: string;
  mono?: boolean;
  emphasize?: boolean;
  sub?: string;
}) {
  return (
    <div>
      <div className="text-[10px] text-text-muted uppercase tracking-[0.12em]">
        {label}
      </div>
      <div
        className={`${emphasize ? "text-base font-semibold" : "text-sm"} ${mono ? "font-mono" : ""} ${className || "text-text-primary"}`}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[9px] text-text-muted font-mono mt-0.5">{sub}</div>
      )}
    </div>
  );
}
