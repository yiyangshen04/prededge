/**
 * One-time CSV import for the 80-week historical dataset.
 *
 * Two CSV shapes are supported:
 *   - `mstr_weeklies_history.csv` (19 rows, no `category`, no `title`)
 *   - `mstr_full_history.csv` (80+ rows with `category` and `title`)
 *
 * Both have a leading `#` index column that becomes the `week_idx` primary
 * key. Idempotent: re-running upserts on `week_idx`.
 *
 * No `csv-parse` dep — neither file has embedded commas in quoted strings
 * (verified by inspection of the source files). The naïve split is safe.
 */

import { readFileSync } from "fs";
import { upsertWeek } from "./db";
import type { WeekRecord } from "./types";

export type CsvShape = "weekly" | "full";

interface ImportResult {
  inserted: number;
  total: number;
  shape: CsvShape;
}

function parseNumber(s: string | undefined): number | null {
  if (s == null) return null;
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseString(s: string | undefined): string | null {
  if (s == null) return null;
  const trimmed = s.trim();
  return trimmed === "" ? null : trimmed;
}

function parseOutcome(s: string | undefined): WeekRecord["outcome"] {
  const v = (s ?? "").trim().toUpperCase();
  if (v === "YES" || v === "NO" || v === "OPEN") return v;
  // Any other value (e.g., "PENDING", empty) → treat as OPEN.
  return "OPEN";
}

function detectShape(headerLine: string): CsvShape {
  const cols = headerLine.split(",").map((c) => c.trim().toLowerCase());
  return cols.includes("category") ? "full" : "weekly";
}

export function importCsvFromPath(absPath: string): ImportResult {
  const raw = readFileSync(absPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { inserted: 0, total: 0, shape: "weekly" };
  }
  const shape = detectShape(lines[0]);
  let inserted = 0;
  const total = lines.length - 1;

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    let row: WeekRecord;

    if (shape === "weekly") {
      // #,startDate,endDate,outcome,open,close,min,max,avg,volume_USD,price_points,condition_id,yes_token,slug
      row = {
        weekIdx: Number(cells[0]),
        startDate: parseString(cells[1]) ?? "",
        endDate: parseString(cells[2]) ?? "",
        outcome: parseOutcome(cells[3]),
        openPrice: parseNumber(cells[4]),
        closePrice: parseNumber(cells[5]),
        minPrice: parseNumber(cells[6]),
        maxPrice: parseNumber(cells[7]),
        avgPrice: parseNumber(cells[8]),
        volumeUsd: parseNumber(cells[9]),
        category: "weekly",
        conditionId: parseString(cells[11]),
        yesTokenId: parseString(cells[12]),
        slug: parseString(cells[13]),
        title: null,
      };
    } else {
      // #,category,startDate,endDate,outcome,open,close,min,max,avg,volume_USD,price_points,condition_id,yes_token,slug,title
      row = {
        weekIdx: Number(cells[0]),
        startDate: parseString(cells[2]) ?? "",
        endDate: parseString(cells[3]) ?? "",
        outcome: parseOutcome(cells[4]),
        openPrice: parseNumber(cells[5]),
        closePrice: parseNumber(cells[6]),
        minPrice: parseNumber(cells[7]),
        maxPrice: parseNumber(cells[8]),
        avgPrice: parseNumber(cells[9]),
        volumeUsd: parseNumber(cells[10]),
        category: parseString(cells[1]),
        conditionId: parseString(cells[12]),
        yesTokenId: parseString(cells[13]),
        slug: parseString(cells[14]),
        // Title may itself contain commas → reconstitute from cells[15..].
        title:
          cells.length > 15
            ? cells.slice(15).join(",").trim() || null
            : null,
      };
    }

    if (!Number.isFinite(row.weekIdx) || row.startDate === "") continue;
    upsertWeek(row);
    inserted++;
  }

  return { inserted, total, shape };
}
