import type { Trade } from "@clarity-btc/shared";

export interface KadoaCrossCheckResult {
  /** Trades present in kadoa's trades.json but missed by our extraction. */
  backfilled: Trade[];
  /** Our rows that disagree with kadoa on range/date/side. */
  conflicts: Trade[];
}

/**
 * Pipeline step 3: cross-check extracted trades against kadoa's
 * congress-trading-monitor `trades.json` (MIT-licensed) and backfill misses.
 * Beware phantom filers (e.g. "Alan Armstrong"): filter `party != null`.
 *
 * TODO(ingest ticket): implement fetch + reconcile.
 */
export async function crossCheckKadoa(_ourTrades: Trade[]): Promise<KadoaCrossCheckResult> {
  return { backfilled: [], conflicts: [] };
}
