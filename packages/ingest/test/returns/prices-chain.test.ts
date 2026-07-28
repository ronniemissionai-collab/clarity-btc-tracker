import { describe, expect, it } from "vitest";
import { KadoaPricesSchema } from "../../src/kadoa/index.js";
import {
  createKadoaPriceProvider,
  createPriceChain,
  createYahooClient,
  createYahooPriceProvider,
  PriceChainExhaustedError,
  PriceUnavailableError,
  type PriceProvider,
  type Quote,
} from "../../src/returns/index.js";
import { readFixtureJson } from "../kadoa/helpers.js";
import { chartBody, yahooFetchStub } from "./helpers.js";

const kadoaPrices = KadoaPricesSchema.parse(readFixtureJson("prices.json"));

describe("createKadoaPriceProvider", () => {
  const provider = createKadoaPriceProvider(kadoaPrices);

  it("answers the current close from the latest snapshot", async () => {
    const quote = await provider.latestClose("BITB");
    expect(quote).toEqual({ date: "2026-07-27", close: 35.20009994506836, source: "kadoa" });
  });

  it("rejects tickers it has no snapshot for", async () => {
    await expect(provider.latestClose("ZZZZ")).rejects.toBeInstanceOf(PriceUnavailableError);
  });

  it("answers closeOnOrAfter only on an exact snapshot date", async () => {
    const quote = await provider.closeOnOrAfter("SPY", "2026-06-26");
    expect(quote).toEqual({ date: "2026-06-26", close: 728.989990234375, source: "kadoa" });
    // A later snapshot exists (2026-07-23) but returning it would skew the
    // cost basis by weeks - it must fall through to Yahoo instead.
    await expect(provider.closeOnOrAfter("SPY", "2026-06-27")).rejects.toBeInstanceOf(
      PriceUnavailableError,
    );
  });
});

describe("createYahooPriceProvider", () => {
  it("prices from the daily series", async () => {
    const client = createYahooClient({
      cacheDir: null,
      fetchFn: yahooFetchStub({
        AAPL: chartBody("AAPL", [
          { date: "2026-05-05", close: 300 },
          { date: "2026-07-24", close: 330 },
        ]),
      }),
    });
    const provider = createYahooPriceProvider(client);
    expect(await provider.closeOnOrAfter("AAPL", "2026-05-01")).toEqual({
      date: "2026-05-05",
      close: 300,
      source: "yahoo",
    });
    expect(await provider.latestClose("AAPL")).toEqual({
      date: "2026-07-24",
      close: 330,
      source: "yahoo",
    });
  });
});

function stubProvider(
  name: PriceProvider["name"],
  behave: (ticker: string) => Quote | Error,
  calls: string[],
): PriceProvider {
  const answer = (ticker: string): Promise<Quote> => {
    calls.push(`${name}:${ticker}`);
    const result = behave(ticker);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  return { name, latestClose: answer, closeOnOrAfter: answer };
}

describe("createPriceChain", () => {
  it("prefers the first provider (kadoa) and never calls the fallback", async () => {
    const calls: string[] = [];
    const chain = createPriceChain([
      stubProvider("kadoa", () => ({ date: "2026-07-27", close: 10, source: "kadoa" }), calls),
      stubProvider("yahoo", () => ({ date: "2026-07-27", close: 99, source: "yahoo" }), calls),
    ]);
    const quote = await chain.latestClose("BITB");
    expect(quote.source).toBe("kadoa");
    expect(quote.close).toBe(10);
    expect(calls).toEqual(["kadoa:BITB"]);
  });

  it("falls through to yahoo when kadoa cannot answer", async () => {
    const calls: string[] = [];
    const chain = createPriceChain([
      stubProvider("kadoa", (t) => new PriceUnavailableError(t, "no snapshot"), calls),
      stubProvider("yahoo", () => ({ date: "2026-07-24", close: 42, source: "yahoo" }), calls),
    ]);
    const quote = await chain.closeOnOrAfter("AAPL", "2026-05-05");
    expect(quote.source).toBe("yahoo");
    expect(calls).toEqual(["kadoa:AAPL", "yahoo:AAPL"]);
  });

  it("aggregates every provider's typed failure when all fail", async () => {
    const calls: string[] = [];
    const chain = createPriceChain([
      stubProvider("kadoa", (t) => new PriceUnavailableError(t, "no snapshot"), calls),
      stubProvider("yahoo", () => new Error("socket hang up"), calls),
    ]);
    const err = await chain.latestClose("ZZZZ").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PriceChainExhaustedError);
    const chainErr = err as PriceChainExhaustedError;
    expect(chainErr.symbol).toBe("ZZZZ");
    expect(chainErr.causes.map((c) => c.code)).toEqual(["unavailable", "http"]);
    expect(chainErr.message).toContain("no snapshot");
    expect(chainErr.message).toContain("socket hang up");
  });
});
