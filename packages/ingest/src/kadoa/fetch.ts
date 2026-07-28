/**
 * Fetch + cache layer for the kadoa congress-trading-monitor datasets (MIT).
 *
 * Datasets are static JSON files refreshed daily in the upstream repo. We cache
 * each download on disk (default `.cache/kadoa/`) and reuse it within
 * `maxAgeMs`; if the network fails and a stale cache exists, the stale copy is
 * served rather than failing the pipeline (third-party continuity risk is the
 * documented reason kadoa is a supplement, not the primary source).
 *
 * Tests inject `fetchFn` and never touch the network.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  KadoaFilerFileSchema,
  KadoaFilerSchema,
  KadoaPricesSchema,
  KadoaReturnSchema,
  KadoaTickerSchema,
  KadoaTradeRowSchema,
  type KadoaFiler,
  type KadoaFilerFile,
  type KadoaPrices,
  type KadoaReturn,
  type KadoaTicker,
  type KadoaTradeRow,
} from "./types.js";

export const KADOA_BASE_URL =
  "https://raw.githubusercontent.com/kadoa-org/congress-trading-monitor/main/public/data";

export type KadoaDataset = "trades" | "filers" | "tickers" | "returns" | "prices";

/** Minimal response surface so tests can stub fetch without undici types. */
export interface KadoaFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type KadoaFetchFn = (url: string) => Promise<KadoaFetchResponse>;

export interface KadoaFetchOptions {
  /** Override the upstream base URL (tests point this at fixtures). */
  baseUrl?: string;
  /** Cache directory; `null` disables the disk cache. Default `.cache/kadoa`. */
  cacheDir?: string | null;
  /** Reuse a cached file younger than this. Default 20 hours (daily refresh). */
  maxAgeMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchFn?: KadoaFetchFn;
}

const DEFAULT_CACHE_DIR = path.join(".cache", "kadoa");
const DEFAULT_MAX_AGE_MS = 20 * 60 * 60 * 1000;

function cacheFileName(relPath: string): string {
  return relPath.replace(/[^a-zA-Z0-9._-]+/g, "__");
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

/**
 * Fetch one JSON document under the kadoa data root, with disk caching.
 * `relPath` is e.g. `"trades.json"` or `"filer/house_brandon_gill.json"`.
 */
export async function fetchKadoaJson(
  relPath: string,
  opts: KadoaFetchOptions = {},
): Promise<unknown> {
  const baseUrl = opts.baseUrl ?? KADOA_BASE_URL;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const cacheDir = opts.cacheDir === null ? null : (opts.cacheDir ?? DEFAULT_CACHE_DIR);
  const fetchFn: KadoaFetchFn = opts.fetchFn ?? ((url) => fetch(url));

  const cacheFile = cacheDir === null ? null : path.join(cacheDir, cacheFileName(relPath));
  const cached = cacheFile === null ? undefined : await readCache(cacheFile, maxAgeMs);
  if (cached?.fresh) return JSON.parse(cached.body) as unknown;

  const url = `${baseUrl}/${relPath}`;
  try {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`kadoa fetch failed: HTTP ${res.status} for ${url}`);
    const body = await res.text();
    const parsed = JSON.parse(body) as unknown; // validate before caching
    if (cacheFile !== null) {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, body, "utf8");
    }
    return parsed;
  } catch (err) {
    // Serve a stale cache over a hard failure.
    if (cached !== undefined) return JSON.parse(cached.body) as unknown;
    throw err;
  }
}

/** Recent-window transactions (top-level `trades.json`, ~5000 newest rows). */
export async function fetchKadoaTrades(opts: KadoaFetchOptions = {}): Promise<KadoaTradeRow[]> {
  return z.array(KadoaTradeRowSchema).parse(await fetchKadoaJson("trades.json", opts));
}

/** All known filers (congress + executive). */
export async function fetchKadoaFilers(opts: KadoaFetchOptions = {}): Promise<KadoaFiler[]> {
  return z.array(KadoaFilerSchema).parse(await fetchKadoaJson("filers.json", opts));
}

/** Ticker-level aggregates. */
export async function fetchKadoaTickers(opts: KadoaFetchOptions = {}): Promise<KadoaTicker[]> {
  return z.array(KadoaTickerSchema).parse(await fetchKadoaJson("tickers.json", opts));
}

/** Per-filer measured-return aggregates. */
export async function fetchKadoaReturns(opts: KadoaFetchOptions = {}): Promise<KadoaReturn[]> {
  return z.array(KadoaReturnSchema).parse(await fetchKadoaJson("returns.json", opts));
}

/** Price snapshots (latest / previous / month close) per ticker. */
export async function fetchKadoaPrices(opts: KadoaFetchOptions = {}): Promise<KadoaPrices> {
  return KadoaPricesSchema.parse(await fetchKadoaJson("prices.json", opts));
}

/**
 * Full trade history for one filer (`filer/{filerId}.json`). This is where the
 * historical backfill lives — the top-level trades.json only holds the most
 * recent filings window.
 */
export async function fetchKadoaFilerTrades(
  filerId: string,
  opts: KadoaFetchOptions = {},
): Promise<KadoaFilerFile> {
  return KadoaFilerFileSchema.parse(await fetchKadoaJson(`filer/${filerId}.json`, opts));
}
