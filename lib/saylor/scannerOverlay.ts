/**
 * Scanner ↔ Saylor bridge.
 *
 * The tail scanner ranks structural tail prices but has no model of an
 * outcome's *true* probability — by design, since it can't for an arbitrary
 * market. The Saylor predictor is the one place we DO have a fair value: it
 * scores P(MSTR buys bitcoin this week) from tweet signals + calendar flags.
 *
 * This module overlays that fair value onto whichever scanned opportunity is
 * the MSTR weekly market, so a bare tail price becomes a model-vs-market edge.
 * It lives in the saylor domain (which already depends on the polymarket
 * client/types) and is invoked from the scan API route — the scanner core
 * stays free of any saylor import, preserving the one-way domain boundary.
 */

import type { Opportunity } from "../types";
import { ensureSeeded } from "./db";
import { resolveEvaluation } from "./evaluate";
import { matchesMstrWeeklyQuestion } from "./polymarketBinding";

/** Market price must exceed the model fair value by at least this (in 0..1)
 * before we treat the model as *contradicting* the tail. 5pp leaves room for
 * normal model/market noise so we only demote on a real disagreement. */
const CONTRADICTION_MARGIN = 0.05;

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * Attach the Saylor model's fair value to any MSTR-weekly opportunities in
 * `opportunities`, mutating them in place. Safe to call unconditionally: if the
 * saylor DB is unavailable or the question doesn't match, opportunities are
 * left untouched. When the model is signal-backed and the market prices the
 * outcome materially richer than the model's fair value, the opportunity is
 * demoted actionable→observe (the tail isn't a real mispricing); when the model
 * agrees it gets an informational `model_backed` reason.
 */
export function annotateOpportunitiesWithSaylorModel(
  opportunities: Opportunity[]
): void {
  const mstrOpps = opportunities.filter((o) =>
    matchesMstrWeeklyQuestion(o.question)
  );
  if (mstrOpps.length === 0) return;

  let probabilityYes: number;
  let recommendation: string;
  let reason: string;
  try {
    ensureSeeded();
    const { prediction } = resolveEvaluation();
    probabilityYes = prediction.probability;
    recommendation = prediction.recommendation;
    reason = prediction.reason;
  } catch {
    // Saylor model unavailable — leave the scanner result untouched.
    return;
  }

  // A silent week (no tweets/signals) yields a flat 0.50 prior; that's too weak
  // to veto a confident market, so we still show it but skip the demotion.
  const signalBacked = reason !== "no_signals";

  for (const opp of mstrOpps) {
    const lower = opp.outcome.toLowerCase();
    const isYes = /yes/.test(lower);
    const isNo = /no/.test(lower);
    // Map the model's P(YES) onto whichever outcome this opportunity is for.
    const fairValue = isYes ? probabilityYes : isNo ? 1 - probabilityYes : null;
    if (fairValue == null) continue; // non-binary outcome — model doesn't apply

    const edge = fairValue - opp.price;
    opp.modelOverlay = {
      source: "saylor-btc-weekly",
      fairValue: round4(fairValue),
      fairValueYes: round4(probabilityYes),
      edgePp: Math.round(edge * 1000) / 10,
      recommendation,
      reason,
    };

    if (
      signalBacked &&
      edge <= -CONTRADICTION_MARGIN &&
      opp.decision === "actionable"
    ) {
      opp.decision = "observe";
      if (!opp.decisionReasons.includes("model_contradicts_market")) {
        opp.decisionReasons.push("model_contradicts_market");
      }
    } else if (edge >= 0 && !opp.decisionReasons.includes("model_backed")) {
      opp.decisionReasons.push("model_backed");
    }
  }
}
