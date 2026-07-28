/**
 * @clarity-btc/ingest - daily pipeline steps, in run order.
 * house/ is implemented (ticket 02); the rest are typed no-op stubs until
 * their build tickets land.
 */
export * from "./house/index.js";
export {
  ingestSenate,
  type SenateIngestOptions,
  type SenateIngestResult,
  type SenatePaperStub,
} from "./senate/index.js";
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
export {
  refreshBill,
  refreshBillDetailed,
  type BillRefreshResult,
  type RefreshBillOptions,
} from "./bill/index.js";
export { computeReturns } from "./returns.js";
