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

export function loadData(): AppData {
  return {
    bill: parseBill(billRaw),
    members: parseMembers(membersRaw),
    holdings: parseHoldings(holdingsRaw),
    trades: parseTrades(tradesRaw),
    traders: parseTraders(tradersRaw),
    news: parseNews(newsRaw),
    meta: parseMeta(metaRaw),
    universe: parseUniverseConfig(universeRaw),
  };
}
