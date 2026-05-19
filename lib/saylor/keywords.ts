/**
 * Saylor暗语 keyword patterns.
 *
 * Each pattern has a weight in [0, 1]:
 *  - 0.95+ : near-certain signal (Saylor explicitly says "back to work" / "no buys")
 *  - 0.85-0.90 : strong signal (canonical orange-dot暗语 from the 80-week dataset)
 *  - 0.70-0.80 : weaker signal (less common phrasing, or older language)
 *
 * The predictor uses max(weight) of matched hits as the base probability,
 * not a sum — multiple BUY hits in a week mean strong commitment but don't
 * compound past the single-tweet ceiling.
 */

export interface KeywordPattern {
  pattern: RegExp;
  phrase: string;
  weight: number;
}

export const BUY_PATTERNS: KeywordPattern[] = [
  { pattern: /big(?:ger)?\s+orange/i, phrase: "Bigger Orange", weight: 0.9 },
  { pattern: /more\s+orange/i, phrase: "More Orange", weight: 0.85 },
  { pattern: /stretch\s+the\s+orange\s+dots?/i, phrase: "Stretch the Orange Dots", weight: 0.9 },
  { pattern: /orange\s+dots?\s+matter/i, phrase: "Orange Dots Matter", weight: 0.85 },
  { pattern: /(it'?s\s+)?orange\s+dot\s+day/i, phrase: "Orange Dot Day", weight: 0.85 },
  { pattern: /take\s+the\s+orange\s+pill/i, phrase: "Take the Orange Pill", weight: 0.8 },
  { pattern: /orange\s+march\s+continues/i, phrase: "Orange March Continues", weight: 0.85 },
  { pattern: /need\s+a\s+bigger\s+orange\s+bag/i, phrase: "Bigger Orange Bag", weight: 0.8 },
  { pattern: /buy\s+the\s+future/i, phrase: "Buy the Future", weight: 0.75 },
  { pattern: /send\s+more\s+orange/i, phrase: "Send More Orange", weight: 0.75 },
  { pattern: /the\s+future\s+is\s+orange/i, phrase: "The Future is Orange", weight: 0.75 },
  { pattern: /unstoppable\s+orange/i, phrase: "Unstoppable Orange", weight: 0.8 },
  { pattern: /we\s+are\s+buying/i, phrase: "We are Buying", weight: 0.9 },
  { pattern: /orange\s+century/i, phrase: "Orange Century", weight: 0.8 },
  { pattern: /ride\s+the\s+orange\s+rocket/i, phrase: "Ride the Orange Rocket", weight: 0.8 },
  // "Back to work" is high-confidence but only valid if prev week was NOBUY.
  // The predictor enforces that gate; the classifier just emits the hit.
  { pattern: /back\s+to\s+work/i, phrase: "Back to Work", weight: 0.95 },
];

export const NOBUY_PATTERNS: KeywordPattern[] = [
  { pattern: /no\s+buys?\s+this\s+week/i, phrase: "No buys this week", weight: 0.95 },
  { pattern: /some\s+weeks\s+(?:just|you).*hodl/i, phrase: "Some weeks just HODL", weight: 0.9 },
  { pattern: /did\s+you\s+hodl/i, phrase: "Did you HODL?", weight: 0.9 },
  { pattern: /ho-?ho-?hodl/i, phrase: "Ho-Ho-HODL", weight: 0.9 },
  { pattern: /no\s+new\s+orange\s+dots/i, phrase: "No new orange dots", weight: 0.85 },
  // Verbatim 8-K language — when this hits, the week is settled.
  {
    pattern: /did\s+not\s+(?:sell\s+any\s+shares|purchase\s+any\s+bitcoin)/i,
    phrase: "8-K: did not purchase any bitcoin",
    weight: 1.0,
  },
];

export const GREEN_PATTERNS: KeywordPattern[] = [
  { pattern: /green\s+dots?/i, phrase: "Green Dots", weight: 0.5 },
  { pattern: /usd\s+reserve/i, phrase: "USD Reserve", weight: 0.5 },
];
