import type { Holding, Trade, UniverseConfig } from "@clarity-btc/shared";

/**
 * Pipeline step 4: derive "currently holds" rows. Baseline = latest annual
 * disclosure positions; subsequent PTRs mutate it (full sale -> sold; partial
 * -> range recomputed by summing lo and hi separately). Filter to the
 * universe config for the holdings view; keep full trades for the roster.
 *
 * TODO(ingest ticket): implement derivation per the data-model Answer (ticket 05).
 */
export async function deriveHoldings(
  _trades: Trade[],
  _universe: UniverseConfig,
): Promise<Holding[]> {
  return [];
}
