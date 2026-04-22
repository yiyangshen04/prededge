import { NextRequest } from "next/server";

/**
 * Per-process, in-memory rate limiter. Good enough to stop accidental
 * retry loops and casual abuse while auth is still TODO; would let a
 * determined attacker slip through on serverless deployments with
 * multiple cold instances.
 */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function clientKey(request: NextRequest): string {
  // x-forwarded-for is the canonical reverse-proxy header on Vercel and
  // most hosted platforms. Falls back to a sentinel for local dev so all
  // localhost requests share one bucket (fine for single-user debugging).
  const fwd = request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "local";
}

/**
 * Fixed-window limiter. Returns null when the request is allowed, or a
 * 429 Response (with Retry-After) when it should be rejected. Caller just
 * does `if (denied) return denied;` at the top of the route handler.
 */
export function enforceRateLimit(
  request: NextRequest,
  route: string,
  limit: number,
  windowMs: number
): Response | null {
  const key = `${route}:${clientKey(request)}`;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }

  if (bucket.count >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return Response.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSec) },
      }
    );
  }

  bucket.count += 1;
  return null;
}
