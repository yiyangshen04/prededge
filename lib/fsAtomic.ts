import { writeFileSync, renameSync, mkdirSync, statSync } from "fs";
import path from "path";

/**
 * Atomically write a file: write to a sibling temp file, then rename over the
 * target. rename(2) is atomic on the same filesystem, so a crash / power loss /
 * ENOSPC mid-write leaves either the old file intact or the fully-written new
 * one — never a truncated half-JSON that the loader would silently reset from.
 *
 * Used by every state file that a cron process rewrites in place
 * (chain-watch-state.json, notify-state.json, heartbeat-state.json).
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

/** st_ino for a path, or null if it does not exist. Used to detect log
 * rotation (tail -c ... > tmp && mv changes the inode). */
export function inodeOf(filePath: string): number | null {
  try {
    return statSync(filePath).ino;
  } catch {
    return null;
  }
}
