/**
 * v1.1 pipeline step: per-member portfolio emission (spec "v1.1 - Full
 * portfolios", build ticket 14).
 *
 * From the merged trades, every member with >= 1 trade gets:
 *   - data/portfolio/{memberId}.json: full all-ticker positions (the holdings
 *     derivation machinery with the universe filter removed - identical
 *     epistemics, official filing URLs mandatory, rejects counted), the full
 *     trade history newest first, a range-midpoint sparkline series, and the
 *     Trader.measured shape (active-roster members) or null;
 *   - one row in data/portfolio/index.json - the directory the site's
 *     portfolio views search/sort over.
 *
 * The core data/trades.json slims to universe-resolved rows only (the site's
 * main bundle must never carry the full trade set), and the trader-card
 * sparkline series is precomputed onto the traders.json rows.
 *
 * Invariant (enforced here and re-checked by the pipeline, NOT a validation
 * gate rule): the index names exactly the portfolio files that are written.
 *
 * v1.2 (build ticket 17): the same derived positions/trades also feed the
 * data/common.json aggregation (common.ts) - securities held by >= 2 members.
 */
import type {
  CommonHolding,
  Holding,
  Member,
  PortfolioFile,
  PortfolioIndexEntry,
  Security,
  SeriesPoint,
  Trade,
  Trader,
} from "@clarity-btc/shared";
import { derivePortfolioPositions, type AllTickerTrade, type HoldingReject } from "../holdings/index.js";
import { extractTicker, rangeMidpoint, type TraderComputation } from "../returns/index.js";
import { buildCommonHoldings } from "./common.js";

export { buildCommonHoldings, COMMON_BUY_DATES_CAP } from "./common.js";
export type { BuildCommonHoldingsOptions } from "./common.js";

// ---------------------------------------------------------------------------
// All-ticker trade resolution
// ---------------------------------------------------------------------------

export interface ResolveAllTickerTradesResult {
  /** Trades that can form positions (resolved or synthesized "other" refs). */
  resolved: AllTickerTrade[];
  /** Trades with no recoverable ticker - they cannot form a keyed position. */
  unresolved: Trade[];
}

/**
 * Give every trade the widest resolvable security ref: universe-resolved refs
 * pass through untouched; otherwise the ticker is recovered from the filing
 * text ("Apple Inc. (AAPL)") with kind "other". Rows with no recoverable
 * ticker (munis, private funds, structured notes...) stay in the member's
 * trade history but are surfaced as unresolved - never guessed.
 */
export function resolveAllTickerTrades(trades: readonly Trade[]): ResolveAllTickerTradesResult {
  const resolved: AllTickerTrade[] = [];
  const unresolved: Trade[] = [];
  for (const trade of trades) {
    if (trade.security !== null) {
      resolved.push(trade);
      continue;
    }
    const ticker = extractTicker(trade.assetRaw);
    if (ticker === null) {
      unresolved.push(trade);
      continue;
    }
    resolved.push({ ...trade, security: { ticker, kind: "other" } });
  }
  return { resolved, unresolved };
}

// ---------------------------------------------------------------------------
// Slimming + series helpers
// ---------------------------------------------------------------------------

/**
 * v1.1: the core data/trades.json keeps only universe-resolved rows - the
 * full all-ticker history lives in the per-member portfolio files.
 */
export function slimTrades<T extends Trade>(trades: readonly T[]): T[] {
  return trades.filter((t) => t.security !== null);
}

/** Range-midpoint sparkline points over a member's trades, ascending by date. */
export function tradeSeries(trades: readonly Trade[]): SeriesPoint[] {
  return [...trades]
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate))
    .map((t) => ({ date: t.transactionDate, value: rangeMidpoint(t.range) }));
}

/**
 * Precompute the trader-card sparkline onto the traders.json rows: each
 * roster member's scored-buy points from the returns computations become
 * {date, value: midpoint} pairs (already ascending by trade date).
 */
export function attachTraderSeries(
  traders: readonly Trader[],
  computations: readonly TraderComputation[],
): Trader[] {
  const byMember = new Map(computations.map((c) => [c.memberId, c.points]));
  return traders.map((trader) => ({
    ...trader,
    series: (byMember.get(trader.memberId) ?? []).map((p) => ({
      date: p.date,
      value: p.midpoint,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Portfolio build
// ---------------------------------------------------------------------------

export interface BuildPortfoliosOptions {
  /** data/members.json - directory metadata for the index rows. */
  members: readonly Member[];
  /** Merged trades (all tickers; provenance-stamped rows pass through). */
  trades: readonly Trade[];
  /** Annual-report holdings baseline (same input the holdings step uses). */
  baseline?: Holding[];
  /** config/traders.json ACTIVE roster ids -> index rosterMember flag. */
  rosterIds?: ReadonlySet<string>;
  /** Trader.measured per roster member (the returns output). */
  measuredById?: ReadonlyMap<string, Trader["measured"]>;
  /** config/universe.json securities - resolves common.json display names. */
  universe?: readonly Security[];
  /** "Today" (ISO date) for stale marking. Default: current UTC date. */
  now?: string;
}

export interface BuildPortfoliosResult {
  /** data/portfolio/index.json rows, tradeCount desc then name. */
  index: PortfolioIndexEntry[];
  /** One data/portfolio/{memberId}.json payload per index row. */
  files: Array<{ memberId: string; file: PortfolioFile }>;
  /**
   * v1.2 data/common.json rows: securities with >= 2 current owners,
   * aggregated from the SAME derived positions/trades the files ship.
   */
  common: CommonHolding[];
  /** Total positions across all files. */
  positionCount: number;
  /** Derivation rejects + ticker-unresolvable trades, counted never guessed. */
  rejects: HoldingReject[];
  warnings: string[];
}

/** Newest first: transaction date desc, then filed date desc. */
function newestFirst(trades: readonly Trade[]): Trade[] {
  return [...trades].sort(
    (a, b) =>
      b.transactionDate.localeCompare(a.transactionDate) ||
      b.filedDate.localeCompare(a.filedDate),
  );
}

export function buildPortfolios(options: BuildPortfoliosOptions): BuildPortfoliosResult {
  const warnings: string[] = [];
  const memberById = new Map(options.members.map((m) => [m.bioguideId, m]));
  const rosterIds = options.rosterIds ?? new Set<string>();

  const { resolved, unresolved } = resolveAllTickerTrades(options.trades);
  const derived = derivePortfolioPositions({
    ...(options.baseline !== undefined ? { baseline: options.baseline } : {}),
    trades: resolved,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const rejects: HoldingReject[] = [
    ...derived.rejects,
    ...unresolved.map((t) => ({
      memberId: t.memberId,
      security: null,
      owner: t.owner ?? null,
      reason: `no resolvable ticker in filing text - trade cannot form a position: ${t.assetRaw}`,
    })),
  ];

  const positionsByMember = new Map<string, PortfolioFile["positions"]>();
  for (const position of derived.positions) {
    const list = positionsByMember.get(position.memberId);
    if (list === undefined) positionsByMember.set(position.memberId, [position]);
    else list.push(position);
  }

  const tradesByMember = new Map<string, Trade[]>();
  for (const trade of options.trades) {
    const list = tradesByMember.get(trade.memberId);
    if (list === undefined) tradesByMember.set(trade.memberId, [trade]);
    else list.push(trade);
  }

  const index: PortfolioIndexEntry[] = [];
  const files: Array<{ memberId: string; file: PortfolioFile }> = [];
  let positionCount = 0;

  for (const [memberId, memberTrades] of tradesByMember) {
    const member = memberById.get(memberId);
    if (member === undefined) {
      warnings.push(
        `portfolio: ${memberId} has ${memberTrades.length} trade(s) but no members.json row - no portfolio emitted`,
      );
      continue;
    }
    const positions = positionsByMember.get(memberId) ?? [];
    positionCount += positions.length;
    const ordered = newestFirst(memberTrades);
    files.push({
      memberId,
      file: {
        member,
        positions,
        trades: ordered,
        series: tradeSeries(memberTrades),
        measured: options.measuredById?.get(memberId) ?? null,
      },
    });
    index.push({
      memberId,
      name: member.name,
      party: member.party,
      chamber: member.chamber,
      state: member.state,
      active: member.active,
      tradeCount: memberTrades.length,
      lastTradeDate: ordered[0]!.transactionDate,
      rosterMember: rosterIds.has(memberId),
    });
  }

  index.sort((a, b) => b.tradeCount - a.tradeCount || a.name.localeCompare(b.name));

  // Pipeline invariant (not a gate rule): index rows == files written.
  if (index.length !== files.length) {
    throw new Error(
      `portfolio invariant violated: ${index.length} index row(s) vs ${files.length} file(s)`,
    );
  }

  // v1.2: common.json comes from the SAME derived positions and resolved
  // trades the per-member files just shipped - one derivation, two views.
  const common = buildCommonHoldings({
    members: options.members,
    positions: derived.positions,
    trades: resolved,
    ...(options.universe !== undefined ? { securities: options.universe } : {}),
  });

  return { index, files, common, positionCount, rejects, warnings };
}
