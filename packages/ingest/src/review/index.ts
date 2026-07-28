/**
 * Pipeline step 5: Exa review layer (build ticket 07).
 *
 * `reviewWithExa` runs the two Exa jobs against ONE strict daily query budget
 * (default 30, configurable; EXA_API_KEY from Actions secrets):
 *
 *   1. News strip first - its small fixed query set (2 by default) must
 *      refresh daily, so it draws from the budget before the per-holding
 *      corroboration loop can consume it.
 *   2. Corroboration of the new/changed BTC-universe rows the caller passes -
 *      1-2 queries each until the budget runs out; rows that get no query stay
 *      "unverified" and are counted in queriesSkipped/skippedHoldings (no
 *      silent caps).
 *
 * Official filings remain the primary source; Exa only moves `verification`
 * toward more information and never downgrades a corroborated row on a no-hit
 * day (see corroborate.ts for the exact transition rules).
 */
import type { Holding, Member, NewsItem, Security, UniverseConfig } from "@clarity-btc/shared";
import { ExaClient } from "./client.js";
import { corroborateHoldings } from "./corroborate.js";
import { buildNewsStrip, DEFAULT_NEWS_QUERIES } from "./news.js";

export {
  DEFAULT_QUERY_BUDGET,
  EXA_SEARCH_URL,
  ExaClient,
  type ExaClientOptions,
  type ExaSearchRequest,
  type ExaSearchResponse,
  type ExaSearchResult,
} from "./client.js";
export { ExaBudgetError, ExaError, type ExaErrorCode } from "./errors.js";
export {
  buildHoldingQueries,
  classifyResult,
  corroborateHoldings,
  memberLastName,
  securityTokens,
  type CorroborateOptions,
  type CorroborateResult,
  type ResultClass,
} from "./corroborate.js";
export {
  buildNewsStrip,
  dedupeAndCap,
  DEFAULT_NEWS_QUERIES,
  MAX_NEWS_ITEMS,
  toNewsItem,
  type NewsStripOptions,
  type NewsStripResult,
} from "./news.js";

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface ExaReviewOptions {
  /** New/changed BTC-universe rows to corroborate (the caller pre-filters). */
  holdings: Holding[];
  /** Roster used to turn memberId into a searchable name. */
  members: Member[];
  /** config/universe.json (or its securities array) for security names. */
  universe: UniverseConfig | Security[];
  /** Prebuilt client (tests); overrides apiKey/fetchImpl/queryBudget. */
  client?: ExaClient;
  /** Defaults to process.env.EXA_API_KEY. */
  apiKey?: string;
  /** Injectable fetch (tests pass a fixture-backed fake; no network). */
  fetchImpl?: typeof fetch;
  /** Strict daily budget across news + corroboration; default 30. */
  queryBudget?: number;
  /** "Today" (ISO date) for recency windows; default current UTC date. */
  now?: string;
  /** Corroboration coverage window; default 90 days. */
  lookbackDays?: number;
  /** 1 or 2 query templates per holding; default 2. */
  maxQueriesPerHolding?: number;
  /** News-strip query set; default DEFAULT_NEWS_QUERIES. */
  newsQueries?: readonly string[];
  /** News-strip recent-days publish filter; default 14. */
  newsRecentDays?: number;
  /** News-strip item cap; default 6. */
  maxNewsItems?: number;
  log?: (line: string) => void;
}

export interface ExaReviewResult {
  /**
   * Input holdings in input order, with `verification` upgraded and news
   * source URLs appended where evidence was found; untouched otherwise.
   */
  reviewed: Holding[];
  /** Refreshed "Latest reporting" strip items (deduped, newest first, <=6). */
  news: NewsItem[];
  /** Queries spent against the daily budget (news + corroboration). */
  queriesUsed: number;
  /** Queries dropped because the budget ran out - reported, never silent. */
  queriesSkipped: number;
  /** Holdings that got zero corroboration queries; they stay "unverified". */
  skippedHoldings: number;
  /** Non-fatal per-query problems; the affected rows stay unchanged. */
  issues: string[];
}

export async function reviewWithExa(options: ExaReviewOptions): Promise<ExaReviewResult> {
  const client =
    options.client ??
    new ExaClient({
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.queryBudget !== undefined ? { queryBudget: options.queryBudget } : {}),
    });

  const news = await buildNewsStrip({
    client,
    queries: options.newsQueries ?? DEFAULT_NEWS_QUERIES,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.newsRecentDays !== undefined ? { recentDays: options.newsRecentDays } : {}),
    ...(options.maxNewsItems !== undefined ? { maxItems: options.maxNewsItems } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });

  const corroboration = await corroborateHoldings(options.holdings, {
    members: options.members,
    universe: options.universe,
    client,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.lookbackDays !== undefined ? { lookbackDays: options.lookbackDays } : {}),
    ...(options.maxQueriesPerHolding !== undefined
      ? { maxQueriesPerHolding: options.maxQueriesPerHolding }
      : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });

  return {
    reviewed: corroboration.reviewed,
    news: news.news,
    queriesUsed: news.queriesUsed + corroboration.queriesUsed,
    queriesSkipped: news.queriesSkipped + corroboration.queriesSkipped,
    skippedHoldings: corroboration.skippedHoldings,
    issues: [...news.issues, ...corroboration.issues],
  };
}
