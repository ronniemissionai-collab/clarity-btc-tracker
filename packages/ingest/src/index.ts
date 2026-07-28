/**
 * @clarity-btc/ingest - daily pipeline steps, in run order.
 * All modules are typed no-op stubs until their build tickets land.
 */
export { ingestHouse, type HouseIngestResult } from "./house.js";
export { ingestSenate, type SenateIngestResult } from "./senate.js";
export {
  crossCheckKadoa,
  fetchKadoaFilerTrades,
  fetchKadoaFilers,
  fetchKadoaPrices,
  fetchKadoaReturns,
  fetchKadoaTickers,
  fetchKadoaTrades,
  mergeTrades,
  normalizeKadoaTrades,
  selectRosterFilerIds,
  type KadoaCrossCheckOptions,
  type KadoaCrossCheckResult,
  type MergedTrade,
  type MergeTradesResult,
  type TradeConflict,
  type TradeProvenance,
} from "./kadoa/index.js";
export { deriveHoldings } from "./holdings.js";
export { reviewWithExa, type ExaReviewResult } from "./review.js";
export { refreshBill } from "./bill.js";
export { computeReturns } from "./returns.js";
