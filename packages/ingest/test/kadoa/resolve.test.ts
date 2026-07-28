import { describe, expect, it } from "vitest";
import { buildSecurityResolver } from "../../src/kadoa/index.js";
import { loadUniverse } from "./helpers.js";

/**
 * Alias/ticker resolution against config/universe.json. Every input shape here
 * was observed in the live kadoa data (see fixtures).
 */
describe("buildSecurityResolver", () => {
  const resolver = buildSecurityResolver(loadUniverse());

  it("resolves plain tickers", () => {
    expect(resolver.resolve({ ticker: "IBIT", assetName: "iShares Bitcoin Trust ETF" })).toEqual({
      ticker: "IBIT",
      kind: "spot-etf",
    });
    expect(
      resolver.resolve({ ticker: "MSTR", assetName: "Strategy Inc - Class A Common Stock" }),
    ).toEqual({ ticker: "MSTR", kind: "treasury" });
    expect(resolver.resolve({ ticker: "BITB", assetName: "Bitwise Bitcoin ETF" })).toEqual({
      ticker: "BITB",
      kind: "spot-etf",
    });
  });

  it("resolves kadoa's duplicated ' - ' asset names without a ticker", () => {
    expect(
      resolver.resolve({
        ticker: null,
        assetName: "iShares Bitcoin Trust ETF - iShares Bitcoin Trust ETF",
      }),
    ).toEqual({ ticker: "IBIT", kind: "spot-etf" });
  });

  it("resolves direct Bitcoin: asset_name 'BTC' with crypto asset_type", () => {
    // Brandon Gill's rows: {ticker: null, asset_name: "BTC", asset_type: "CT"}
    expect(resolver.resolve({ ticker: null, assetName: "BTC", assetType: "CT" })).toEqual({
      ticker: "BTC",
      kind: "direct",
    });
  });

  it("resolves direct Bitcoin: ticker 'BTC' + asset_name 'Bitcoin'", () => {
    // Reschenthaler's sale: {ticker: "BTC", asset_name: "Bitcoin", asset_type: "CT"}
    expect(resolver.resolve({ ticker: "BTC", assetName: "Bitcoin", assetType: "CT" })).toEqual({
      ticker: "BTC",
      kind: "direct",
    });
  });

  it("resolves direct Bitcoin: parenthetical 'BTC (Bitcoin)'", () => {
    expect(resolver.resolve({ ticker: null, assetName: "BTC (Bitcoin)", assetType: "CT" })).toEqual(
      { ticker: "BTC", kind: "direct" },
    );
  });

  it("disambiguates the BTC ticker collision toward the Grayscale Mini Trust by name", () => {
    expect(
      resolver.resolve({ ticker: "BTC", assetName: "Grayscale Bitcoin Mini Trust ETF" }),
    ).toEqual({ ticker: "BTC", kind: "spot-etf" });
  });

  it("gives null for the bare ambiguous 'BTC' ticker with no hints", () => {
    expect(resolver.resolve({ ticker: "BTC" })).toBeNull();
  });

  it("resolves retired-ticker aliases (SMLR -> ASST after the Strive acquisition)", () => {
    expect(resolver.resolve({ ticker: "SMLR", assetName: "Semler Scientific, Inc." })).toEqual({
      ticker: "ASST",
      kind: "treasury",
    });
  });

  it("resolves universe names case/punctuation-insensitively", () => {
    expect(resolver.resolve({ ticker: null, assetName: "COINBASE GLOBAL, INC." })).toEqual({
      ticker: "COIN",
      kind: "exchange",
    });
  });

  it("returns null for assets outside the universe", () => {
    expect(
      resolver.resolve({ ticker: "NVDA", assetName: "NVIDIA Corporation - Common Stock" }),
    ).toBeNull();
    expect(resolver.resolve({ ticker: null, assetName: "US Treasury Note 4.25%" })).toBeNull();
    expect(resolver.resolve({ ticker: null, assetName: null })).toBeNull();
  });
});
