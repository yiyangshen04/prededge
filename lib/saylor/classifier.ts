/**
 * Pure-function regex classifier for Saylor tweets.
 *
 * No I/O. Given a tweet string, returns the *strongest* signal hit per signal
 * family (BUY / NOBUY / GREEN). A tweet that matches both "Big Orange" and
 * "Orange Dots Matter" returns one BUY hit at the higher weight — multiple
 * BUY hits in the SAME tweet are merged. The predictor handles the
 * within-week aggregation.
 */

import {
  BUY_PATTERNS,
  GREEN_PATTERNS,
  NOBUY_PATTERNS,
  type KeywordPattern,
} from "./keywords";
import type { SaylorTweet, SignalHit, SignalType } from "./types";

function bestMatch(
  text: string,
  patterns: KeywordPattern[]
): KeywordPattern | null {
  let best: KeywordPattern | null = null;
  for (const p of patterns) {
    if (!p.pattern.test(text)) continue;
    if (!best || p.weight > best.weight) best = p;
  }
  return best;
}

/**
 * Classify a single tweet. Returns up to 3 hits (one per family) — the caller
 * should typically expect 0 or 1, but a particularly loaded tweet ("Bigger
 * Orange. Green dots too.") can fire multiple families.
 */
export function classifyTweet(text: string, tweetId?: string): SignalHit[] {
  const families: Array<[SignalType, KeywordPattern[]]> = [
    ["BUY", BUY_PATTERNS],
    ["NOBUY", NOBUY_PATTERNS],
    ["GREEN", GREEN_PATTERNS],
  ];

  const hits: SignalHit[] = [];
  for (const [type, patterns] of families) {
    const match = bestMatch(text, patterns);
    if (!match) continue;
    hits.push({
      type,
      matchedPhrase: match.phrase,
      weight: match.weight,
      tweetId: tweetId ?? null,
    });
  }
  return hits;
}

/**
 * Classify every tweet in a window. Returns the flat list of all hits across
 * all tweets — the predictor groups these later by family.
 */
export function classifyWeek(tweets: SaylorTweet[]): SignalHit[] {
  const out: SignalHit[] = [];
  for (const t of tweets) {
    out.push(...classifyTweet(t.text, t.id));
  }
  return out;
}
