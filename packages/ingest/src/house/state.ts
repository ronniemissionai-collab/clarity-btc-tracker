/**
 * Resumable seen-DocID state. A DocID is only marked seen after its filing was
 * fully processed (trades emitted, OCR stub emitted, or unmatched-but-parsed),
 * so any download/extract failure is retried on the next run.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HouseIngestError, errorMessage } from "./errors.js";
import type { HouseState } from "./types.js";

export function emptyHouseState(): HouseState {
  return { version: 1, years: {} };
}

function isHouseState(value: unknown): value is HouseState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { version?: unknown; years?: unknown };
  if (v.version !== 1 || typeof v.years !== "object" || v.years === null) return false;
  return Object.values(v.years).every(
    (y) =>
      typeof y === "object" &&
      y !== null &&
      Array.isArray((y as { seenDocIds?: unknown }).seenDocIds) &&
      ((y as { seenDocIds: unknown[] }).seenDocIds as unknown[]).every(
        (d) => typeof d === "string",
      ),
  );
}

/** Load state; a missing file yields the empty state, corrupt state throws. */
export async function loadHouseState(path: string): Promise<HouseState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyHouseState();
    throw new HouseIngestError("state-io", `cannot read state ${path}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HouseIngestError("state-io", `state file ${path} is not valid JSON`, { cause: err });
  }
  if (!isHouseState(parsed)) {
    throw new HouseIngestError("state-io", `state file ${path} has an unexpected shape`);
  }
  return parsed;
}

/** Atomically persist state (write temp file in place, then rename). */
export async function saveHouseState(path: string, state: HouseState): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.house-state-${process.pid}.tmp`);
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch (err) {
    throw new HouseIngestError("state-io", `cannot write state ${path}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

export function seenDocIds(state: HouseState, year: number): Set<string> {
  return new Set(state.years[String(year)]?.seenDocIds ?? []);
}

export function withSeenDocIds(state: HouseState, year: number, seen: Set<string>): HouseState {
  return {
    version: 1,
    years: {
      ...state.years,
      [String(year)]: { seenDocIds: [...seen].sort() },
    },
  };
}
