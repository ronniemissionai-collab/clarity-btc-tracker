import type { Holding, NewsItem } from "@clarity-btc/shared";

export interface ExaReviewResult {
  /** Holdings with verification upgraded (unverified -> corroborated/conflict). */
  reviewed: Holding[];
  /** Refreshed "Latest reporting" strip items. */
  news: NewsItem[];
}

/**
 * Pipeline step 5: Exa review layer (EXA_API_KEY from Actions secrets).
 * Corroborate new/changed BTC-universe rows against news coverage, record
 * filing-vs-news conflicts, and refresh the news strip. Official filings stay
 * the primary source; Exa only upgrades/downgrades `verification`.
 *
 * TODO(review ticket): implement query templates per the data-model Answer.
 */
export async function reviewWithExa(changed: Holding[]): Promise<ExaReviewResult> {
  return { reviewed: changed, news: [] };
}
