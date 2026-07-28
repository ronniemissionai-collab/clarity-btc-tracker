/**
 * Price provider chain: kadoa snapshots first, Yahoo v8 fallback.
 *
 * kadoa `prices.json` only carries three snapshots per ticker (latest /
 * previous / month close), so it answers "current close" cheaply but can only
 * answer a historical date when a snapshot lands exactly on it - anything else
 * falls through to Yahoo's daily series. Every failure is a typed PriceError;
 * when the whole chain fails the caller gets a PriceChainExhaustedError with
 * each provider's cause attached.
 */
import type { KadoaPrices } from "../kadoa/index.js";
import {
  asPriceError,
  PriceChainExhaustedError,
  type PriceError,
  PriceUnavailableError,
} from "./errors.js";
import { closeOnOrAfter, latestClose, type YahooClient } from "./yahoo.js";

export type PriceSource = "kadoa" | "yahoo";

export interface Quote {
  /** ISO date the close is for. */
  date: string;
  close: number;
  source: PriceSource;
}

export interface PriceProvider {
  readonly name: PriceSource;
  /** Most recent daily close for the ticker. */
  latestClose(ticker: string): Promise<Quote>;
  /** First daily close on or after the ISO date. */
  closeOnOrAfter(ticker: string, isoDate: string): Promise<Quote>;
}

export function createKadoaPriceProvider(prices: KadoaPrices): PriceProvider {
  return {
    name: "kadoa",
    latestClose(ticker: string): Promise<Quote> {
      const snap = prices[ticker]?.latest;
      if (snap == null) {
        return Promise.reject(
          new PriceUnavailableError(ticker, `kadoa prices.json has no latest close for ${ticker}`),
        );
      }
      return Promise.resolve({ date: snap.date, close: snap.close, source: "kadoa" });
    },
    closeOnOrAfter(ticker: string, isoDate: string): Promise<Quote> {
      // Only an exact snapshot-date hit is trustworthy: returning the *next*
      // snapshot (weeks later) would silently skew the cost basis.
      const entry = prices[ticker];
      const snaps = [entry?.month, entry?.previous, entry?.latest];
      const hit = snaps.find((s) => s != null && s.date === isoDate);
      if (hit == null) {
        return Promise.reject(
          new PriceUnavailableError(
            ticker,
            `kadoa prices.json has no snapshot on ${isoDate} for ${ticker}`,
          ),
        );
      }
      return Promise.resolve({ date: hit.date, close: hit.close, source: "kadoa" });
    },
  };
}

export function createYahooPriceProvider(client: YahooClient): PriceProvider {
  return {
    name: "yahoo",
    async latestClose(ticker: string): Promise<Quote> {
      const series = await client.dailySeries(ticker);
      const point = latestClose(series);
      if (point === undefined) {
        throw new PriceUnavailableError(ticker, `yahoo series for ${ticker} is empty`);
      }
      return { ...point, source: "yahoo" };
    },
    async closeOnOrAfter(ticker: string, isoDate: string): Promise<Quote> {
      const series = await client.dailySeries(ticker);
      const point = closeOnOrAfter(series, isoDate);
      if (point === undefined) {
        throw new PriceUnavailableError(
          ticker,
          `yahoo series for ${ticker} has no close on/after ${isoDate}`,
        );
      }
      return { ...point, source: "yahoo" };
    },
  };
}

export interface PriceChain {
  latestClose(ticker: string): Promise<Quote>;
  closeOnOrAfter(ticker: string, isoDate: string): Promise<Quote>;
}

/** Try providers in order; throw PriceChainExhaustedError when all fail. */
export function createPriceChain(providers: PriceProvider[]): PriceChain {
  async function attempt(
    ticker: string,
    call: (provider: PriceProvider) => Promise<Quote>,
  ): Promise<Quote> {
    const causes: PriceError[] = [];
    for (const provider of providers) {
      try {
        return await call(provider);
      } catch (err) {
        causes.push(asPriceError(err, `provider ${provider.name}`));
      }
    }
    throw new PriceChainExhaustedError(ticker, causes);
  }

  return {
    latestClose: (ticker) => attempt(ticker, (p) => p.latestClose(ticker)),
    closeOnOrAfter: (ticker, isoDate) =>
      attempt(ticker, (p) => p.closeOnOrAfter(ticker, isoDate)),
  };
}
