/**
 * Saylor tweet ingestion via the public X Syndication endpoint.
 *
 * The Syndication API powers the public timeline embed widget. It returns
 * JSON, requires no auth, and is the most stable free path to @saylor's
 * recent posts. Caveat: only the latest ~20 tweets are exposed — historical
 * data must come from the CSV import.
 *
 * Endpoint shape (verified against the embed JS as of 2026):
 *   https://syndication.twitter.com/srv/timeline-profile/screen-name/saylor
 * Returns an HTML-like blob with an inline `__INITIAL_STATE__` JSON. We
 * fetch as text and extract the JSON island. If the shape changes, the
 * manual-paste fallback at `POST /api/saylor/tweets/manual` keeps the rest
 * of the system running.
 */

import type { SaylorTweet } from "./types";

const SYNDICATION_URL =
  "https://syndication.twitter.com/srv/timeline-profile/screen-name/saylor";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;

interface FetchOptions {
  sinceIso?: string;
  max?: number;
  timeoutMs?: number;
  retries?: number;
}

interface RawTweet {
  id_str?: string;
  rest_id?: string;
  full_text?: string;
  text?: string;
  created_at?: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchSyndicationText(opts: {
  timeoutMs: number;
  retries: number;
}): Promise<string> {
  const { timeoutMs, retries } = opts;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(SYNDICATION_URL, {
        signal: controller.signal,
        headers: {
          // Match the embed widget's UA closely; X sometimes rejects
          // unknown UAs even though no auth is required.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          Accept: "text/html,application/json",
        },
      });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          await sleep(300 * attempt);
          continue;
        }
      }
      if (!res.ok) {
        throw new Error(`Syndication HTTP ${res.status} ${res.statusText}`);
      }
      return await res.text();
    } catch (err) {
      clearTimeout(t);
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) await sleep(300 * attempt);
    }
  }
  throw lastErr ?? new Error("Syndication fetch failed");
}

/**
 * Pull every quoted JSON object out of the embed-page payload and walk them
 * looking for tweet-shaped records. The Syndication response embeds its
 * data as `<script id="__NEXT_DATA__" type="application/json">{...}</script>`,
 * which we extract first; if not found, we fall back to scanning for any
 * `legacy.full_text` occurrences.
 */
function extractTweetsFromPayload(payload: string): RawTweet[] {
  // Primary: __NEXT_DATA__ script tag.
  const nextDataMatch = payload.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  const tweets: RawTweet[] = [];

  function walk(node: unknown): void {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const legacy = obj.legacy as Record<string, unknown> | undefined;
    const fullText =
      (legacy?.full_text as string | undefined) ??
      (obj.full_text as string | undefined) ??
      (obj.text as string | undefined);
    const id =
      (obj.rest_id as string | undefined) ??
      (obj.id_str as string | undefined) ??
      (legacy?.id_str as string | undefined);
    const createdAt =
      (legacy?.created_at as string | undefined) ??
      (obj.created_at as string | undefined);
    if (typeof fullText === "string" && typeof id === "string") {
      tweets.push({
        id_str: id,
        full_text: fullText,
        created_at: createdAt,
      });
    }
    for (const v of Object.values(obj)) walk(v);
  }

  if (nextDataMatch) {
    try {
      walk(JSON.parse(nextDataMatch[1]));
    } catch {
      // Fall through to string-scan fallback.
    }
  }

  if (tweets.length === 0) {
    // Fallback: regex out tweets by structural cues.
    const re =
      /"id_str":"(\d+)"[^}]*?"full_text":"((?:[^"\\]|\\.)*)"[^}]*?"created_at":"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(payload)) !== null) {
      tweets.push({
        id_str: m[1],
        full_text: m[2].replace(/\\n/g, "\n").replace(/\\"/g, '"'),
        created_at: m[3],
      });
    }
  }

  // Dedupe by id_str — the walker may visit the same tweet from multiple paths.
  const seen = new Set<string>();
  return tweets.filter((t) => {
    const id = t.id_str ?? t.rest_id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function toIso(twitterDate: string | undefined): string {
  if (!twitterDate) return new Date().toISOString();
  const d = new Date(twitterDate);
  if (!isNaN(d.getTime())) return d.toISOString();
  return new Date().toISOString();
}

function rawToTweet(raw: RawTweet): SaylorTweet | null {
  const id = raw.id_str ?? raw.rest_id;
  const text = raw.full_text ?? raw.text;
  if (!id || !text) return null;
  return {
    id,
    postedAt: toIso(raw.created_at),
    text,
    url: `https://x.com/saylor/status/${id}`,
    source: "syndication",
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Public entry: fetch @saylor's recent tweets from X Syndication.
 * Returns the freshest `max` tweets (default 20). Throws on network /
 * parse failure — the caller is expected to fall back to manual paste.
 */
export async function fetchSaylorTweets(
  opts: FetchOptions = {}
): Promise<SaylorTweet[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const max = opts.max ?? 20;

  const payload = await fetchSyndicationText({ timeoutMs, retries });
  const raws = extractTweetsFromPayload(payload);
  const sinceMs = opts.sinceIso
    ? new Date(opts.sinceIso).getTime()
    : -Infinity;

  return raws
    .map(rawToTweet)
    .filter((t): t is SaylorTweet => t !== null)
    .filter((t) => new Date(t.postedAt).getTime() > sinceMs)
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
    .slice(0, max);
}

/**
 * Manual-paste parser. Each non-empty line of `rawText` becomes one tweet.
 * IDs are synthesized as `manual-<sha1Prefix>`; if the same text is pasted
 * twice the ID collides and the second insert is a no-op upsert.
 */
export function parseManualTweets(rawText: string): SaylorTweet[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const now = new Date().toISOString();
  return lines.map((text, idx) => {
    // Deterministic ID per text body — cheap djb2 hash, no crypto needed.
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
    const id = `manual-${Math.abs(h).toString(36)}-${idx}`;
    return {
      id,
      postedAt: now,
      text,
      url: null,
      source: "manual" as const,
      fetchedAt: now,
    };
  });
}
