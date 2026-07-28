import type { Trade, Trader, TradersConfig } from "@clarity-btc/shared";

/**
 * Pipeline step 7: compute per-trader performance. Primary source: kadoa's
 * precomputed per-trade `ret_since` / `excess_since` fields; fallback prices
 * from the Yahoo v8 chart API (browser User-Agent, cached, low volume).
 * Skip stooq (datacenter IPs get a proof-of-work challenge). Position sizes
 * use disclosed-range midpoints vs SPY - always labeled as estimates.
 *
 * TODO(returns ticket): implement per the portfolio methodology (ticket 11).
 */
export async function computeReturns(
  _roster: TradersConfig,
  _trades: Trade[],
): Promise<Trader[]> {
  return [];
}
