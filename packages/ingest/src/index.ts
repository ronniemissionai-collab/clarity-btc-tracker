/**
 * @clarity-btc/ingest - daily pipeline steps, in run order.
 * house/ (ticket 02), senate/ (03), kadoa/ (04), holdings/ (05), bill/ (06),
 * review/ (07), returns/ (08), portfolio/ (v1.1, ticket 14), and the
 * pipeline orchestrator + CLI (11).
 */
export {
  carryForwardVerification,
  DATA_FILES,
  FAILURE_REPORT_FILE,
  PORTFOLIO_DIR,
  runPipeline,
  type PipelineFailure,
  type PipelineIO,
  type PipelineResult,
  type RunPipelineOptions,
} from "./pipeline.js";
export {
  createDryRunIO,
  DRY_RUN_EXPECTATIONS_PATH,
  DRY_RUN_NOW,
  FIXTURES_DIR,
  seedDryRunState,
} from "./dryrun.js";
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
  derivePortfolioPositions,
  loadExpectations,
  validateHoldings,
  type AllTickerTrade,
  type DeriveHoldingsOptions,
  type DeriveHoldingsResult,
  type DerivePortfolioPositionsOptions,
  type DerivePortfolioPositionsResult,
  type HoldingReject,
  type UniverseIndex,
  type ValidateHoldingsOptions,
  type ValidationFailure,
  type ValidationReport,
} from "./holdings/index.js";
export {
  buildNewsStrip,
  corroborateHoldings,
  DEFAULT_NEWS_QUERIES,
  DEFAULT_QUERY_BUDGET,
  ExaBudgetError,
  ExaClient,
  ExaError,
  reviewWithExa,
  type CorroborateOptions,
  type CorroborateResult,
  type ExaClientOptions,
  type ExaReviewOptions,
  type ExaReviewResult,
  type ExaSearchRequest,
  type ExaSearchResponse,
  type ExaSearchResult,
  type NewsStripOptions,
  type NewsStripResult,
} from "./review/index.js";
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
export {
  attachTraderSeries,
  buildPortfolios,
  resolveAllTickerTrades,
  slimTrades,
  tradeSeries,
  type BuildPortfoliosOptions,
  type BuildPortfoliosResult,
  type ResolveAllTickerTradesResult,
} from "./portfolio/index.js";
