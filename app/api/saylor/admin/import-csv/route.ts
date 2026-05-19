import { NextRequest } from "next/server";
import path from "path";
import { importCsvFromPath } from "@/lib/saylor/csvImport";

export const runtime = "nodejs";

/**
 * POST /api/saylor/admin/import-csv
 * Body: { path?: string }
 *
 * `path`, if supplied, is treated as a *basename* only and resolved under
 * the project's `data/saylor/` directory. Absolute paths, `..` segments,
 * and explicit subdirectories are rejected to prevent path traversal —
 * earlier versions of this route accepted arbitrary filesystem paths.
 *
 * If no body is sent, both default history files are imported.
 */

const CSV_DIR = path.join(process.cwd(), "data/saylor");
const DEFAULT_FILES = [
  "mstr_weeklies_history.csv",
  "mstr_full_history.csv",
];

/**
 * Resolve a user-supplied filename to an absolute path strictly inside
 * `CSV_DIR`. Returns null if the input contains directory separators,
 * `..`, or otherwise escapes the directory.
 */
function safeResolve(name: string): string | null {
  // Reject anything that looks like a path, not a filename.
  if (name.length === 0) return null;
  if (name.includes("/") || name.includes("\\")) return null;
  if (name === "." || name === "..") return null;
  const abs = path.resolve(CSV_DIR, name);
  // Belt-and-suspenders: ensure resolution stayed inside CSV_DIR.
  const rel = path.relative(CSV_DIR, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}

/** Display-safe path (no server FS leakage) for error responses + UI. */
function publicName(absPath: string): string {
  return path.basename(absPath);
}

export async function POST(request: NextRequest) {
  let body: { path?: string } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  let candidates: string[];
  if (body.path) {
    const resolved = safeResolve(body.path);
    if (!resolved) {
      return Response.json(
        { error: "Invalid filename — must be a basename inside data/saylor/" },
        { status: 400 }
      );
    }
    candidates = [resolved];
  } else {
    candidates = DEFAULT_FILES.map((f) => path.join(CSV_DIR, f));
  }

  const results: Array<{ path: string; inserted: number; shape: string }> = [];
  try {
    for (const c of candidates) {
      const r = importCsvFromPath(c);
      results.push({ path: publicName(c), inserted: r.inserted, shape: r.shape });
    }
    return Response.json({ ok: true, results });
  } catch (err) {
    console.error("[api/saylor/admin/import-csv] failed:", err);
    return Response.json(
      {
        error: err instanceof Error ? err.message : "Import failed",
        partial: results,
      },
      { status: 500 }
    );
  }
}
