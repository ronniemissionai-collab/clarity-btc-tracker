/**
 * Pipeline step 7: prices + trader returns -> data/traders.json rows.
 *
 * Per active roster member (config/traders.json), from the merged trades:
 *  - every disclosed BUY gets a range-midpoint cost basis and a since-trade
 *    return vs the current close - kadoa's precomputed per-trade
 *    `ret_since`/`excess_since` first, Yahoo v8 chart pricing as fallback
 *    (kadoa latest-close snapshots preferred for the current close);
 *  - options/unpriceable positions (Pelosi LEAPS case) are EXCLUDED and
 *    counted, never guessed;
 *  - the member aggregate is the midpoint-weighted mean, with excess vs SPY
 *    over the same windows.
 * Every figure is an estimate - filings disclose value bands, not amounts.
 *
 * The shared Trader schema has no sparkline field, so per-trade return points
 * ship in the parallel `computations` structure of the result (integration
 * note: data/traders.json rows carry only the schema fields; the site already
 * derives its sparklines from trades.json).
 */
import {
  TraderSchema,
  type Member,
  type Trade,
  type Trader,
  type TradersConfig,
} from "@clarity-btc/shared";
import {
  fetchKadoaFilers,
  fetchKadoaFilerTrades,
  fetchKadoaPrices,
  fetchKadoaTrades,
  type KadoaFetchOptions,
  type KadoaFiler,
  type KadoaPrices,
  type KadoaTradeRow,
} from "../kadoa/index.js";
import { buildMemberMatcher } from "../kadoa/members.js";
import {
  aggregateMidpointWeighted,
  extractTicker,
  isOptionsPosition,
  rangeMidpoint,
  round1,
  simpleReturnPct,
  type TradeReturnPoint,
} from "./compute.js";
import { claimsSupportedByMeasured } from "./claims.js";
import { PriceError } from "./errors.js";
import { buildKadoaReturnLookup, type KadoaReturnLookup } from "./kadoaLookup.js";
import {
  createKadoaPriceProvider,
  createPriceChain,
  createYahooPriceProvider,
  type PriceChain,
} from "./prices.js";
import { createYahooClient, type YahooClientOptions } from "./yahoo.js";

export * from "./errors.js";
export { claimsSupportedByMeasured, extractClaimedReturnPct } from "./claims.js";
export {
  aggregateMidpointWeighted,
  extractTicker,
  isOptionsPosition,
  rangeMidpoint,
  round1,
  simpleReturnPct,
  type AggregateReturn,
  type TradeReturnPoint,
} from "./compute.js";
export {
  buildKadoaReturnLookup,
  type KadoaReturnLookup,
  type KadoaTradeReturn,
} from "./kadoaLookup.js";
export {
  createKadoaPriceProvider,
  createPriceChain,
  createYahooPriceProvider,
  type PriceChain,
  type PriceProvider,
  type PriceSource,
  type Quote,
} from "./prices.js";
export {
  BROWSER_USER_AGENT,
  closeOnOrAfter,
  createYahooClient,
  latestClose,
  parseYahooChart,
  YAHOO_CHART_BASE_URL,
  type DailySeries,
  type PricePoint,
  type YahooClient,
  type YahooClientOptions,
  type YahooFetchFn,
  type YahooFetchResponse,
} from "./yahoo.js";

export const BENCHMARK_TICKER = "SPY";

export interface ComputeReturnsOptions {
  /** kadoa fetch/caching knobs (tests inject fetchFn; no network in tests). */
  kadoa?: KadoaFetchOptions;
  /** Yahoo client knobs (tests inject fetchFn; no network in tests). */
  yahoo?: YahooClientOptions;
  /**
   * Member roster used to resolve kadoa filer names. Defaults to minimal
   * members synthesized from the traders config itself.
   */
  members?: Member[];
  /** Valuation stamp for `measured.asOf`. Default: today (UTC). */
  asOf?: string;
}

/** A buy we refused to price, with the reason it was excluded. */
export interface UnpriceableTrade {
  date: string;
  assetRaw: string;
  midpoint: number;
  reason: string;
}

/** Per-member working detail - parallel structure next to the Trader rows. */
export interface TraderComputation {
  memberId: string;
  /** Scored buys, ascending by trade date (sparkline-ready). */
  points: TradeReturnPoint[];
  /** Excluded buys, counted with reasons (options, no ticker, no prices). */
  unpriceable: UnpriceableTrade[];
}

export interface ComputeReturnsResult {
  /** data/traders.json rows (shared Trader schema), sorted by tradeCount desc. */
  traders: Trader[];
  /** Per-member per-trade return points + exclusions, keyed like traders. */
  computations: TraderComputation[];
  /** Non-fatal problems (kadoa outage, benchmark gaps, ...). */
  warnings: string[];
}

/** Minimal Member stubs so the kadoa name matcher can run from config alone. */
function membersFromRoster(roster: TradersConfig): Member[] {
  return [...roster.active, ...roster.watch].map((entry) => ({
    bioguideId: entry.id,
    name: entry.name,
    party: entry.party,
    chamber: entry.chamber,
    state: "XX", // unknown here; the matcher only uses name + chamber
    active: true,
  }));
}

const OWNER_LABEL: Record<NonNullable<Trade["owner"]>, string> = {
  self: "self",
  spouse: "spouse",
  dependent: "dependent",
  joint: "joint",
  trust: "trust",
};

/** Whose trades these are, derived from the filings' owner fields. */
export function deriveAttribution(trades: Trade[]): string {
  const counts = new Map<string, number>();
  for (const t of trades) {
    if (t.owner === undefined) continue;
    const label = OWNER_LABEL[t.owner];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return "self (owner not stated in filings)";
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label)
    .join(" + ");
}

interface KadoaInputs {
  lookup: KadoaReturnLookup | undefined;
  prices: KadoaPrices | undefined;
}

async function loadKadoaInputs(
  roster: TradersConfig,
  members: Member[],
  fetchOpts: KadoaFetchOptions,
  warnings: string[],
): Promise<KadoaInputs> {
  let lookup: KadoaReturnLookup | undefined;
  let prices: KadoaPrices | undefined;

  try {
    const [recentRows, filers] = await Promise.all([
      fetchKadoaTrades(fetchOpts),
      fetchKadoaFilers(fetchOpts),
    ]);
    const rows: KadoaTradeRow[] = [...recentRows];
    const allFilers: KadoaFiler[] = [...filers];
    const matcher = buildMemberMatcher(members);
    const rosterIds = new Set(roster.active.map((e) => e.id));
    const filerIds = filers
      .filter(
        (f) =>
          f.branch === "congress" &&
          f.party != null &&
          f.party !== "" &&
          rosterIds.has(matcher.match(f.full_name, f.chamber)?.bioguideId ?? ""),
      )
      .map((f) => f.id)
      .sort();
    for (const filerId of filerIds) {
      try {
        const file = await fetchKadoaFilerTrades(filerId, fetchOpts);
        allFilers.push(file.filer);
        rows.push(...file.trades);
      } catch {
        // Missing per-filer file only costs backfill depth for that member.
      }
    }
    lookup = buildKadoaReturnLookup(rows, allFilers, members);
  } catch (err) {
    warnings.push(
      `kadoa returns unavailable, falling back to Yahoo pricing only: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  try {
    prices = await fetchKadoaPrices(fetchOpts);
  } catch (err) {
    warnings.push(
      `kadoa prices.json unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { lookup, prices };
}

/** Price one buy via the provider chain; excess vs SPY over the same window. */
async function priceViaChain(
  chain: PriceChain,
  ticker: string,
  tradeDate: string,
  warnings: string[],
): Promise<{ ret: number; excess: number | null; source: TradeReturnPoint["source"] }> {
  const entry = await chain.closeOnOrAfter(ticker, tradeDate);
  const current = await chain.latestClose(ticker);
  const ret = simpleReturnPct(entry.close, current.close);
  let excess: number | null = null;
  try {
    const spyEntry = await chain.closeOnOrAfter(BENCHMARK_TICKER, tradeDate);
    const spyCurrent = await chain.latestClose(BENCHMARK_TICKER);
    excess = ret - simpleReturnPct(spyEntry.close, spyCurrent.close);
  } catch (err) {
    warnings.push(
      `SPY benchmark unavailable for window starting ${tradeDate}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const source: TradeReturnPoint["source"] =
    entry.source === "kadoa" && current.source === "kadoa" ? "kadoa" : "yahoo";
  return { ret, excess, source };
}

function windowLabel(points: TradeReturnPoint[]): string {
  const dates = points.map((p) => p.date).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const span = first === last ? first : `${first} to ${last}`;
  return `disclosed buys ${span}, since-trade, midpoint-weighted`;
}

const ESTIMATE_NOTE =
  "Estimate: position sizes are disclosed-range midpoints, never exact amounts.";

export async function computeReturns(
  roster: TradersConfig,
  trades: Trade[],
  options: ComputeReturnsOptions = {},
): Promise<ComputeReturnsResult> {
  const warnings: string[] = [];
  const members = options.members ?? membersFromRoster(roster);
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);

  const { lookup, prices } = await loadKadoaInputs(
    roster,
    members,
    options.kadoa ?? {},
    warnings,
  );
  const yahoo = createYahooClient(options.yahoo ?? {});
  const chain = createPriceChain([
    ...(prices !== undefined ? [createKadoaPriceProvider(prices)] : []),
    createYahooPriceProvider(yahoo),
  ]);

  const tradesByMember = new Map<string, Trade[]>();
  for (const trade of trades) {
    const list = tradesByMember.get(trade.memberId);
    if (list === undefined) tradesByMember.set(trade.memberId, [trade]);
    else list.push(trade);
  }

  const traders: Trader[] = [];
  const computations: TraderComputation[] = [];

  for (const entry of roster.active) {
    const memberTrades = tradesByMember.get(entry.id) ?? [];
    const buys = memberTrades.filter((t) => t.side === "buy");
    const points: TradeReturnPoint[] = [];
    const unpriceable: UnpriceableTrade[] = [];

    for (const trade of buys) {
      const midpoint = rangeMidpoint(trade.range);
      const kadoaInfo = lookup?.find(trade);

      if (isOptionsPosition(trade.assetRaw, kadoaInfo?.assetType)) {
        unpriceable.push({
          date: trade.transactionDate,
          assetRaw: trade.assetRaw,
          midpoint,
          reason: "options position - cannot be marked to market from equity closes",
        });
        continue;
      }

      if (kadoaInfo !== undefined && kadoaInfo.retSince !== null) {
        points.push({
          date: trade.transactionDate,
          ticker: kadoaInfo.ticker,
          midpoint,
          ret: kadoaInfo.retSince,
          excess: kadoaInfo.excessSince,
          source: "kadoa",
        });
        continue;
      }

      const ticker =
        kadoaInfo?.ticker ?? trade.security?.ticker ?? extractTicker(trade.assetRaw);
      if (ticker === null || ticker === undefined) {
        unpriceable.push({
          date: trade.transactionDate,
          assetRaw: trade.assetRaw,
          midpoint,
          reason: "no listed ticker resolvable from the filing text",
        });
        continue;
      }

      try {
        const priced = await priceViaChain(chain, ticker, trade.transactionDate, warnings);
        points.push({
          date: trade.transactionDate,
          ticker,
          midpoint,
          ret: priced.ret,
          excess: priced.excess,
          source: priced.source,
        });
      } catch (err) {
        const detail = err instanceof PriceError ? `[${err.code}] ${err.message}` : String(err);
        unpriceable.push({
          date: trade.transactionDate,
          assetRaw: trade.assetRaw,
          midpoint,
          reason: `no price data for ${ticker}: ${detail}`,
        });
      }
    }

    points.sort((a, b) => a.date.localeCompare(b.date));
    const aggregate = aggregateMidpointWeighted(points);

    let measured: Trader["measured"] = null;
    let noMeasureReason: string | undefined;
    if (aggregate !== null) {
      const exclusionNote =
        unpriceable.length > 0
          ? ` ${unpriceable.length} unpriceable position(s) excluded (options or no resolvable price).`
          : "";
      measured = {
        return: round1(aggregate.return),
        ...(aggregate.excess !== null ? { excess: round1(aggregate.excess) } : {}),
        method: "midpoint",
        benchmark: "SPY",
        window: windowLabel(points),
        asOf,
        note: `${ESTIMATE_NOTE}${exclusionNote}`,
      };
    } else if (memberTrades.length === 0) {
      noMeasureReason = "no merged trades for this member yet";
    } else if (buys.length === 0) {
      noMeasureReason = "no disclosed buys in the merged filings (sells only)";
    } else {
      const optionsCount = unpriceable.filter((u) => u.reason.startsWith("options")).length;
      noMeasureReason =
        `all ${buys.length} disclosed buy(s) are unpriceable` +
        (optionsCount > 0 ? ` (${optionsCount} options position(s))` : "");
    }

    const noteParts = [
      ...(entry.note !== undefined ? [entry.note] : []),
      ...(noMeasureReason !== undefined ? [`Not measured: ${noMeasureReason}.`] : []),
    ];

    const claimsSupported = claimsSupportedByMeasured(
      entry.claims,
      measured === null ? null : measured.return,
    );
    const trader = TraderSchema.parse({
      memberId: entry.id,
      tradeCount: memberTrades.length,
      claims: entry.claims,
      measured,
      attribution: deriveAttribution(memberTrades),
      ...(claimsSupported !== undefined ? { claimsSupported } : {}),
      ...(noteParts.length > 0 ? { note: noteParts.join(" ") } : {}),
    });
    traders.push(trader);
    computations.push({ memberId: entry.id, points, unpriceable });
  }

  // Rank by trade count (roster order breaks ties); computations stay aligned.
  const rosterOrder = new Map(roster.active.map((e, i) => [e.id, i]));
  const byRank = (aId: string, aCount: number, bId: string, bCount: number): number =>
    bCount - aCount || (rosterOrder.get(aId) ?? 0) - (rosterOrder.get(bId) ?? 0);
  const countByMember = new Map(traders.map((t) => [t.memberId, t.tradeCount]));
  traders.sort((a, b) => byRank(a.memberId, a.tradeCount, b.memberId, b.tradeCount));
  computations.sort((a, b) =>
    byRank(
      a.memberId,
      countByMember.get(a.memberId) ?? 0,
      b.memberId,
      countByMember.get(b.memberId) ?? 0,
    ),
  );

  return { traders, computations, warnings };
}
