/**
 * Loads the seven data/*.json outputs (plus the security universe config,
 * needed to resolve each holding's tier) and validates everything through the
 * shared-contract parse helpers. Invalid data throws — main.ts renders the
 * error state rather than showing wrong numbers.
 */
import {
  parseBill,
  parseHoldings,
  parseMembers,
  parseMeta,
  parseNews,
  parseTraders,
  parseTrades,
  parseUniverseConfig,
  type Bill,
  type Holding,
  type Member,
  type Meta,
  type NewsItem,
  type Trade,
  type Trader,
  type UniverseConfig,
} from "@clarity-btc/shared";

import billRaw from "../../data/bill.json";
import holdingsRaw from "../../data/holdings.json";
import membersRaw from "../../data/members.json";
import metaRaw from "../../data/meta.json";
import newsRaw from "../../data/news.json";
import tradersRaw from "../../data/traders.json";
import tradesRaw from "../../data/trades.json";
import universeRaw from "../../config/universe.json";

export interface AppData {
  bill: Bill;
  members: Member[];
  holdings: Holding[];
  trades: Trade[];
  traders: Trader[];
  news: NewsItem[];
  meta: Meta;
  universe: UniverseConfig;
}

export interface RawDataset {
  bill: unknown;
  members: unknown;
  holdings: unknown;
  trades: unknown;
  traders: unknown;
  news: unknown;
  meta: unknown;
  universe?: unknown;
}

export function parseDataset(raw: RawDataset): AppData {
  return {
    bill: parseBill(raw.bill),
    members: parseMembers(raw.members),
    holdings: parseHoldings(raw.holdings),
    trades: parseTrades(raw.trades),
    traders: parseTraders(raw.traders),
    news: parseNews(raw.news),
    meta: parseMeta(raw.meta),
    universe: parseUniverseConfig(raw.universe ?? universeRaw),
  };
}

export function loadData(): AppData {
  return parseDataset({
    bill: billRaw,
    members: membersRaw,
    holdings: holdingsRaw,
    trades: tradesRaw,
    traders: tradersRaw,
    news: newsRaw,
    meta: metaRaw,
    universe: universeRaw,
  });
}
