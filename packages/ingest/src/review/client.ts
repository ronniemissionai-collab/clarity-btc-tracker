/**
 * Minimal typed client for POST https://api.exa.ai/search.
 *
 * - Auth: x-api-key from options.apiKey, falling back to EXA_API_KEY (GitHub
 *   Actions secret). Constructing without a key throws immediately - better
 *   than burning the whole run on per-query 401s.
 * - Retry: exactly one retry on a 5xx status. 4xx never retries.
 * - Budget: a strict per-client daily query budget (default 30, configurable).
 *   `search` throws ExaBudgetError once the budget is used up; callers that
 *   want to degrade gracefully check `queriesRemaining` first and report the
 *   drop (no silent caps). A retry of the same query consumes no extra budget.
 * - fetch is injectable so tests run fixture-backed with no network.
 */
import { z } from "zod";
import { ExaBudgetError, ExaError, errorMessage } from "./errors.js";

export const EXA_SEARCH_URL = "https://api.exa.ai/search";

/** Strict daily query budget default (~$0.007/search on Exa's free credit). */
export const DEFAULT_QUERY_BUDGET = 30;

// ---------------------------------------------------------------------------
// Request / response shapes (verified against a live capture, 2026-07-28)
// ---------------------------------------------------------------------------

export interface ExaSearchRequest {
  query: string;
  type?: "auto" | "neural" | "keyword" | "fast";
  /** Content-category focus; the news strip passes "news". */
  category?: "news";
  numResults?: number;
  /** ISO datetime lower bound on publish date, e.g. "2026-07-14T00:00:00.000Z". */
  startPublishedDate?: string;
  endPublishedDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  /** Ask for page text so classification can read snippets, not just titles. */
  contents?: { text?: boolean | { maxCharacters?: number } };
}

const ExaSearchResultSchema = z
  .object({
    title: z.string().nullish(),
    url: z.string().min(1),
    publishedDate: z.string().nullish(),
    author: z.string().nullish(),
    text: z.string().nullish(),
  })
  .passthrough();

const ExaSearchResponseSchema = z
  .object({
    requestId: z.string().optional(),
    resolvedSearchType: z.string().optional(),
    results: z.array(ExaSearchResultSchema),
  })
  .passthrough();

export type ExaSearchResult = z.infer<typeof ExaSearchResultSchema>;
export type ExaSearchResponse = z.infer<typeof ExaSearchResponseSchema>;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ExaClientOptions {
  /** Defaults to process.env.EXA_API_KEY; constructing without either throws. */
  apiKey?: string;
  /** Injectable fetch (tests pass a fixture-backed fake; no network). */
  fetchImpl?: typeof fetch;
  searchUrl?: string;
  /** Strict daily query budget; default DEFAULT_QUERY_BUDGET (30). */
  queryBudget?: number;
}

export class ExaClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly searchUrl: string;
  private readonly budget: number;
  private used = 0;

  constructor(options: ExaClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.EXA_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new ExaError(
        "missing-api-key",
        "no Exa API key: set EXA_API_KEY (Actions secret) or pass options.apiKey",
      );
    }
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.searchUrl = options.searchUrl ?? EXA_SEARCH_URL;
    this.budget = options.queryBudget ?? DEFAULT_QUERY_BUDGET;
  }

  /** Queries counted against the budget so far (retries are not counted). */
  get queriesUsed(): number {
    return this.used;
  }

  /** Queries left in the strict daily budget. */
  get queriesRemaining(): number {
    return Math.max(0, this.budget - this.used);
  }

  /** The configured budget (for logging/reporting). */
  get queryBudget(): number {
    return this.budget;
  }

  /**
   * One search against the budget. Throws ExaBudgetError when exhausted;
   * retries exactly once on a 5xx status.
   */
  async search(request: ExaSearchRequest): Promise<ExaSearchResponse> {
    if (this.queriesRemaining <= 0) throw new ExaBudgetError(this.budget);
    this.used += 1;

    let response = await this.post(request);
    if (response.status >= 500) {
      response = await this.post(request); // retry once on 5xx
    }
    if (!response.ok) {
      const hint = response.status === 401 ? " (is EXA_API_KEY valid?)" : "";
      throw new ExaError(
        "http",
        `Exa search returned ${response.status}${hint} for query "${request.query}"`,
        { status: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new ExaError("bad-response", "Exa search returned a non-JSON body", {
        cause,
      });
    }
    const parsed = ExaSearchResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExaError(
        "bad-response",
        `Exa search response did not match the expected shape: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data;
  }

  private async post(request: ExaSearchRequest): Promise<Response> {
    try {
      return await this.fetchImpl(this.searchUrl, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(request),
      });
    } catch (cause) {
      throw new ExaError(
        "network",
        `POST ${this.searchUrl} failed: ${errorMessage(cause)}`,
        { cause },
      );
    }
  }
}
