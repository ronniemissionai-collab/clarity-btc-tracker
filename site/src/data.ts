/**
 * Loads the small data/*.json outputs (plus the security universe config,
 * needed to resolve each holding's tier) and validates everything through the
 * shared-contract parse helpers. Invalid data throws — main.ts renders the
 * error state rather than showing wrong numbers.
 *
 * The 16MB data/trades.json is deliberately NOT imported here: the main
 * bundle must stay lean (see the bundle-budget test). Trader-card sparklines
 * read the precomputed per-trader `series` on data/traders.json rows, and the
 * full per-member trade history is fetched lazily from /data/portfolio/
 * (see portfolioData.ts).
 */
import {
  parseBill,
  parseHoldings,
  parseMembers,
  parseMeta,
  parseNews,
  parseTraders,
  parseUniverseConfig,
  type Bill,
  type Holding,
  type Member,
  type Meta,
  type NewsItem,
  type Trader,
  type UniverseConfig,
} from "@clarity-btc/shared";
import type { SparkPoint } from "./components/sparkline";

import billRaw from "../../data/bill.json";
import holdingsRaw from "../../data/holdings.json";
import membersRaw from "../../data/members.json";
import metaRaw from "../../data/meta.json";
import newsRaw from "../../data/news.json";
import tradersRaw from "../../data/traders.json";
import universeRaw from "../../config/universe.json";

export interface AppData {
  bill: Bill;
  members: Member[];
  holdings: Holding[];
  traders: Trader[];
  /**
   * Precomputed sparkline points per trader (memberId → series), read from
   * the optional `series` field on data/traders.json rows. Empty until the
   * pipeline emits it — the sparkline shows its honest empty state.
   */
  traderSeries: Map<string, SparkPoint[]>;
  news: NewsItem[];
  meta: Meta;
  universe: UniverseConfig;
}

export interface RawDataset {
  bill: unknown;
  members: unknown;
  holdings: unknown;
  traders: unknown;
  news: unknown;
  meta: unknown;
  universe?: unknown;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates one `series` array from a traders.json row. The shared schema
 * strips unknown keys, so the field is re-read from the raw row here; this
 * shim goes away once @clarity-btc/shared adds `series` to TraderSchema
 * (pipeline ticket 14).
 */
export function parseSparkSeries(raw: unknown, context: string): SparkPoint[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${context}: series must be an array of {date, value} points`);
  }
  return raw.map((point, i) => {
    if (
      !isRecord(point) ||
      typeof point["date"] !== "string" ||
      !ISO_DATE.test(point["date"]) ||
      typeof point["value"] !== "number" ||
      !Number.isFinite(point["value"])
    ) {
      throw new Error(`${context}: series[${i}] must be {date: "YYYY-MM-DD", value: number}`);
    }
    return { date: point["date"], value: point["value"] };
  });
}

/** Reads the optional per-trader `series` off the raw traders.json rows. */
export function extractTraderSeries(raw: unknown): Map<string, SparkPoint[]> {
  const series = new Map<string, SparkPoint[]>();
  if (!Array.isArray(raw)) return series;
  for (const row of raw) {
    if (!isRecord(row) || typeof row["memberId"] !== "string") continue;
    if (row["series"] === undefined) continue;
    series.set(row["memberId"], parseSparkSeries(row["series"], `traders row ${row["memberId"]}`));
  }
  return series;
}

export function parseDataset(raw: RawDataset): AppData {
  return {
    bill: parseBill(raw.bill),
    members: parseMembers(raw.members),
    holdings: parseHoldings(raw.holdings),
    traders: parseTraders(raw.traders),
    traderSeries: extractTraderSeries(raw.traders),
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
    traders: tradersRaw,
    news: newsRaw,
    meta: metaRaw,
    universe: universeRaw,
  });
}
