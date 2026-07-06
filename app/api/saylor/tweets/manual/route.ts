import { NextRequest } from "next/server";
import { classifyTweet } from "@/lib/saylor/classifier";
import { mondayOf } from "@/lib/saylor/calendar";
import { saveSignals, upsertTweet } from "@/lib/saylor/db";
import { parseManualTweets } from "@/lib/saylor/twitterSource";
import { enforceRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

/**
 * POST /api/saylor/tweets/manual
 * Body: { rawText: string }
 * Each non-empty line becomes one tweet. Classifier runs immediately and
 * resulting signals are persisted against the current Monday's week.
 */
export async function POST(request: NextRequest) {
  // Writes classifier signals into the predictor's input DB — rate-limit it
  // like the other write routes so it can't be spammed from the LAN.
  const limited = enforceRateLimit(request, "saylor-tweets-manual", 10, 10_000);
  if (limited) return limited;
  let body: { rawText?: string } = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.rawText !== "string" || body.rawText.trim().length === 0) {
    return Response.json(
      { error: "rawText must be a non-empty string" },
      { status: 400 }
    );
  }

  const tweets = parseManualTweets(body.rawText);
  const weekStart = mondayOf(new Date());
  const insertedSignals: Array<{
    tweetId: string;
    type: string;
    matchedPhrase: string;
  }> = [];

  for (const t of tweets) {
    upsertTweet(t);
    const hits = classifyTweet(t.text, t.id);
    if (hits.length > 0) {
      saveSignals(hits, weekStart);
      for (const h of hits) {
        insertedSignals.push({
          tweetId: t.id,
          type: h.type,
          matchedPhrase: h.matchedPhrase,
        });
      }
    }
  }

  return Response.json({
    inserted: tweets.length,
    signals: insertedSignals,
  });
}
