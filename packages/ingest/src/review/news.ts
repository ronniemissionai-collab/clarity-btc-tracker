/**
 * The "Latest reporting" news strip (data/news.json).
 *
 * A separate, small daily query set - CLARITY Act progress + congressional
 * bitcoin disclosure headlines - keeps the page alive while official bill
 * actions sit static for months. Results map onto the shared NewsItem
 * contract (title, url, source domain, ISO date), dedupe by URL, sort newest
 * first, cap at 6.
 */
import type { NewsItem } from "@clarity-btc/shared";
import { NewsItemSchema } from "@clarity-btc/shared";
import type { ExaClient, ExaSearchResult } from "./client.js";
import { startPublishedDate, todayIso } from "./dates.js";
import { errorMessage } from "./errors.js";

export const DEFAULT_NEWS_QUERIES: readonly string[] = [
  "CLARITY Act crypto market structure bill congress bitcoin news",
  "congress member bitcoin holdings disclosure filing news",
];

/** Strip cap - the design shows at most six items. */
export const MAX_NEWS_ITEMS = 6;

export interface NewsStripOptions {
  client: ExaClient;
  /** Query set; default DEFAULT_NEWS_QUERIES (2 queries). */
  queries?: readonly string[];
  /** "Today" (ISO date) anchoring the recency window; default current UTC date. */
  now?: string;
  /** Recent-days publish filter; default 14. */
  recentDays?: number;
  /** Item cap after dedupe+sort; default MAX_NEWS_ITEMS (6). */
  maxItems?: number;
  /** Results requested per query; default 8. */
  numResultsPerQuery?: number;
  log?: (line: string) => void;
}

export interface NewsStripResult {
  news: NewsItem[];
  queriesUsed: number;
  /** Queries not issued because the daily budget ran out (each one logged). */
  queriesSkipped: number;
  issues: string[];
}

/**
 * Map one Exa result onto the NewsItem contract; null when it lacks a title,
 * a parseable publish date, or a valid URL (dropped, not fabricated).
 */
export function toNewsItem(result: ExaSearchResult): NewsItem | null {
  const title = result.title?.trim();
  const publishedAt = result.publishedDate?.slice(0, 10);
  if (title === undefined || title === "") return null;
  if (publishedAt === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) return null;
  let source: string;
  try {
    source = new URL(result.url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
  const item: NewsItem = { title, url: result.url, source, publishedAt };
  return NewsItemSchema.safeParse(item).success ? item : null;
}

/** Dedupe by URL (first wins), sort newest first, cap. */
export function dedupeAndCap(items: NewsItem[], maxItems: number): NewsItem[] {
  const byUrl = new Map<string, NewsItem>();
  for (const item of items) {
    if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  }
  return [...byUrl.values()]
    .sort((a, b) =>
      a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0,
    )
    .slice(0, maxItems);
}

export async function buildNewsStrip(options: NewsStripOptions): Promise<NewsStripResult> {
  const { client } = options;
  const log = options.log ?? (() => {});
  const queries = options.queries ?? DEFAULT_NEWS_QUERIES;
  const now = options.now ?? todayIso();
  const publishedAfter = startPublishedDate(now, options.recentDays ?? 14);
  const maxItems = options.maxItems ?? MAX_NEWS_ITEMS;
  const numResults = options.numResultsPerQuery ?? 8;

  const usedBefore = client.queriesUsed;
  const collected: NewsItem[] = [];
  const issues: string[] = [];
  let queriesSkipped = 0;

  for (const query of queries) {
    if (client.queriesRemaining <= 0) {
      queriesSkipped += 1;
      log(`exa budget exhausted: skipped news query "${query}"`);
      continue;
    }
    try {
      const response = await client.search({
        query,
        type: "auto",
        category: "news",
        numResults,
        startPublishedDate: publishedAfter,
        contents: { text: { maxCharacters: 1000 } },
      });
      for (const result of response.results) {
        const item = toNewsItem(result);
        if (item !== null) collected.push(item);
      }
    } catch (err) {
      issues.push(`news query "${query}" failed: ${errorMessage(err)}`);
    }
  }

  return {
    news: dedupeAndCap(collected, maxItems),
    queriesUsed: client.queriesUsed - usedBefore,
    queriesSkipped,
    issues,
  };
}
