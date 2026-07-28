/**
 * @clarity-btc/ingest - daily pipeline steps, in run order.
 * house/ (ticket 02), senate/ (03), kadoa/ (04), holdings/ (05), and bill/
 * (06) are implemented; the rest are typed no-op stubs until their build
 * tickets land.
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
export {
  buildUniverseIndex,
  deriveHoldings,
  loadExpectations,
  validateHoldings,
  type DeriveHoldingsOptions,
  type DeriveHoldingsResult,
  type HoldingReject,
  type UniverseIndex,
  type ValidateHoldingsOptions,
  type ValidationFailure,
  type ValidationReport,
} from "./holdings/index.js";
export { reviewWithExa, type ExaReviewResult } from "./review.js";
export {
  refreshBill,
  refreshBillDetailed,
  type BillRefreshResult,
  type RefreshBillOptions,
} from "./bill/index.js";
export {
  computeReturns,
  createKadoaPriceProvider,
  createPriceChain,
  createYahooClient,
  createYahooPriceProvider,
  PriceChainExhaustedError,
  PriceError,
  PriceFetchError,
  PriceParseError,
  PriceUnavailableError,
  type ComputeReturnsOptions,
  type ComputeReturnsResult,
  type PriceChain,
  type PriceProvider,
  type TradeReturnPoint,
  type TraderComputation,
  type UnpriceableTrade,
  type YahooClient,
  type YahooClientOptions,
} from "./returns/index.js";
