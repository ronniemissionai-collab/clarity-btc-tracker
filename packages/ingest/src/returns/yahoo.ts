/**
 * Yahoo Finance v8 chart client - the price fallback behind kadoa.
 *
 * `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=...&interval=1d`
 * works keyless with a plain browser User-Agent (probed live 2026-07-28; see
 * research ticket 10). It is unofficial and can rate-limit, so every series is
 * cached twice: in-memory per client (one request per symbol per run) and on
 * disk (default `.cache/yahoo/`, reused within `maxAgeMs`, served stale when
 * the network fails - same continuity policy as the kadoa fetch layer).
 *
 * Tests inject `fetchFn` and never touch the network.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PriceFetchError, PriceParseError, PriceUnavailableError } from "./errors.js";

export const YAHOO_CHART_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

/** A real browser UA - Yahoo rejects default fetch/curl agents. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** One daily close. Dividend-adjusted when Yahoo provides adjclose. */
export interface PricePoint {
  /** ISO trading date (UTC calendar date of the session timestamp). */
  date: string;
  close: number;
}

/** Daily close series, ascending by date. */
export interface DailySeries {
  symbol: string;
  points: PricePoint[];
}

/** Minimal response surface so tests can stub fetch. */
export interface YahooFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type YahooFetchFn = (
  url: string,
  headers: Record<string, string>,
) => Promise<YahooFetchResponse>;

export interface YahooClientOptions {
  /** Override the chart base URL (tests). */
  baseUrl?: string;
  /** Yahoo range parameter, e.g. "3mo", "1y", "2y". Default "2y". */
  range?: string;
  /** Disk cache directory; `null` disables it. Default `.cache/yahoo`. */
  cacheDir?: string | null;
  /** Reuse a disk-cached series younger than this. Default 20 hours. */
  maxAgeMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchFn?: YahooFetchFn;
  userAgent?: string;
}

export interface YahooClient {
  /** Daily close series for one symbol (memory -> disk -> network). */
  dailySeries(symbol: string): Promise<DailySeries>;
}

const DEFAULT_CACHE_DIR = path.join(".cache", "yahoo");
const DEFAULT_MAX_AGE_MS = 20 * 60 * 60 * 1000;
const DEFAULT_RANGE = "2y";

const YahooChartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z
          .object({
            timestamp: z.array(z.number()).optional(),
            indicators: z.object({
              quote: z
                .array(z.object({ close: z.array(z.number().nullable()).optional() }).passthrough())
                .optional(),
              adjclose: z
                .array(z.object({ adjclose: z.array(z.number().nullable()).optional() }))
                .optional(),
            }),
          })
          .passthrough(),
      )
      .nullish(),
    error: z
      .object({ code: z.string().nullish(), description: z.string().nullish() })
      .passthrough()
      .nullish(),
  }),
});

function isoDateOf(unixSeconds: number): string {
  // US-market session timestamps land mid-day UTC, so the UTC calendar date is
  // the trading date.
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** Parse a v8 chart body into a DailySeries. Throws typed errors. */
export function parseYahooChart(symbol: string, body: string): DailySeries {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new PriceParseError(`yahoo chart for ${symbol}: body is not JSON`, { cause: err });
  }
  const parsed = YahooChartSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PriceParseError(`yahoo chart for ${symbol}: unexpected shape`, {
      cause: parsed.error,
    });
  }
  const { result, error } = parsed.data.chart;
  if (error != null) {
    throw new PriceUnavailableError(
      symbol,
      `yahoo: ${error.code ?? "error"}: ${error.description ?? "no data"}`,
    );
  }
  const first = result?.[0];
  if (first === undefined) {
    throw new PriceUnavailableError(symbol, `yahoo: empty result for ${symbol}`);
  }
  const timestamps = first.timestamp ?? [];
  const closes = first.indicators.quote?.[0]?.close ?? [];
  const adjcloses = first.indicators.adjclose?.[0]?.adjclose ?? [];

  const points: PricePoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    if (ts === undefined) continue;
    const close = adjcloses[i] ?? closes[i];
    if (close == null) continue; // holidays/halts publish null slots
    points.push({ date: isoDateOf(ts), close });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  if (points.length === 0) {
    throw new PriceUnavailableError(symbol, `yahoo: no usable closes for ${symbol}`);
  }
  return { symbol, points };
}

/** First close on or after the ISO date (trades can land on weekends/holidays). */
export function closeOnOrAfter(series: DailySeries, isoDate: string): PricePoint | undefined {
  return series.points.find((p) => p.date >= isoDate);
}

/** Most recent close in the series. */
export function latestClose(series: DailySeries): PricePoint | undefined {
  return series.points[series.points.length - 1];
}

function cacheFileName(symbol: string, range: string): string {
  return `${symbol}_${range}`.replace(/[^a-zA-Z0-9._-]+/g, "__") + ".json";
}

async function readCache(
  file: string,
  maxAgeMs: number,
): Promise<{ fresh: boolean; body: string } | undefined> {
  try {
    const s = await stat(file);
    const body = await readFile(file, "utf8");
    return { fresh: Date.now() - s.mtimeMs <= maxAgeMs, body };
  } catch {
    return undefined;
  }
}

export function createYahooClient(opts: YahooClientOptions = {}): YahooClient {
  const baseUrl = opts.baseUrl ?? YAHOO_CHART_BASE_URL;
  const range = opts.range ?? DEFAULT_RANGE;
  const cacheDir = opts.cacheDir === null ? null : (opts.cacheDir ?? DEFAULT_CACHE_DIR);
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const userAgent = opts.userAgent ?? BROWSER_USER_AGENT;
  const fetchFn: YahooFetchFn =
    opts.fetchFn ?? (async (url, headers) => fetch(url, { headers }));

  /** One request per symbol per process - keeps daily Action volume low. */
  const memory = new Map<string, Promise<DailySeries>>();

  async function load(symbol: string): Promise<DailySeries> {
    const cacheFile =
      cacheDir === null ? null : path.join(cacheDir, cacheFileName(symbol, range));
    const cached = cacheFile === null ? undefined : await readCache(cacheFile, maxAgeMs);
    if (cached?.fresh) return parseYahooChart(symbol, cached.body);

    const url = `${baseUrl}/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d`;
    let body: string;
    try {
      const res = await fetchFn(url, {
        "User-Agent": userAgent,
        Accept: "application/json",
      });
      if (!res.ok) {
        throw new PriceFetchError(`yahoo chart HTTP ${res.status} for ${symbol}`, res.status);
      }
      body = await res.text();
    } catch (err) {
      // Serve a stale cache over a hard network failure.
      if (cached !== undefined) return parseYahooChart(symbol, cached.body);
      if (err instanceof PriceFetchError) throw err;
      throw new PriceFetchError(
        `yahoo chart fetch failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        { cause: err },
      );
    }
    const series = parseYahooChart(symbol, body); // validate before caching
    if (cacheFile !== null) {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, body, "utf8");
    }
    return series;
  }

  return {
    dailySeries(symbol: string): Promise<DailySeries> {
      const hit = memory.get(symbol);
      if (hit !== undefined) return hit;
      const pending = load(symbol);
      // Don't memoize failures - a retry within the run may still succeed.
      pending.catch(() => memory.delete(symbol));
      memory.set(symbol, pending);
      return pending;
    },
  };
}
