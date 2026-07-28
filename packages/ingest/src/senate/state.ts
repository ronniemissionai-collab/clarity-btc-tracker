/**
 * Resumable last-run state for the Senate ingest step.
 *
 * The daily Action persists this next to its other run artifacts; on the next
 * run the search window starts at `lastSubmittedDate` (inclusive — eFD's
 * submitted_start_date filter is >=, so same-day filings reappear) and
 * `processedFilingIds` deduplicates what was already ingested.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SenateStateError } from "./errors.js";

export interface SenateIngestState {
  /** ISO date of the most recently submitted filing processed; null = never ran. */
  lastSubmittedDate: string | null;
  /** Filing uuids already ingested (most recent kept, capped). */
  processedFilingIds: string[];
}

/** Cap on remembered filing ids (~ several years of Senate filings). */
const MAX_PROCESSED_IDS = 5000;

export function initialSenateState(): SenateIngestState {
  return { lastSubmittedDate: null, processedFilingIds: [] };
}

/** Fold newly processed filings into the state (pure). */
export function advanceSenateState(
  state: SenateIngestState,
  processed: { filingId: string; filedDate: string }[],
): SenateIngestState {
  let last = state.lastSubmittedDate;
  const ids = [...state.processedFilingIds];
  for (const { filingId, filedDate } of processed) {
    if (last === null || filedDate > last) last = filedDate;
    if (!ids.includes(filingId)) ids.push(filingId);
  }
  return {
    lastSubmittedDate: last,
    processedFilingIds: ids.slice(-MAX_PROCESSED_IDS),
  };
}

/** Load state from disk; a missing file yields the initial state. */
export async function loadSenateState(path: string): Promise<SenateIngestState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return initialSenateState();
    }
    throw new SenateStateError(`cannot read senate state at ${path}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new SenateStateError(`senate state at ${path} is not valid JSON`, { cause });
  }
  if (!isSenateState(parsed)) {
    throw new SenateStateError(`senate state at ${path} has an unexpected shape`);
  }
  return parsed;
}

export async function saveSenateState(
  path: string,
  state: SenateIngestState,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (cause) {
    throw new SenateStateError(`cannot write senate state to ${path}`, { cause });
  }
}

function isSenateState(value: unknown): value is SenateIngestState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const dateOk =
    v["lastSubmittedDate"] === null ||
    (typeof v["lastSubmittedDate"] === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(v["lastSubmittedDate"]));
  const idsOk =
    Array.isArray(v["processedFilingIds"]) &&
    v["processedFilingIds"].every((id) => typeof id === "string");
  return dateOk && idsOk;
}
