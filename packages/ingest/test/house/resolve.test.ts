import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Member, UniverseConfig } from "@clarity-btc/shared";
import { parseUniverseConfig } from "@clarity-btc/shared";
import {
  buildSecurityResolver,
  districtFromStateDst,
  parsePtrText,
  resolveHouseMember,
} from "../../src/house/index.js";
import type { HouseFiling } from "../../src/house/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const universe: UniverseConfig = parseUniverseConfig(
  JSON.parse(readFileSync(join(repoRoot, "config", "universe.json"), "utf8")),
);

const filing = (over: Partial<HouseFiling>): HouseFiling => ({
  prefix: "Hon.",
  last: "Biggs",
  first: "Sheri",
  suffix: "",
  filingType: "P",
  stateDst: "SC03",
  year: 2026,
  filedDate: "2026-03-21",
  docId: "20034195",
  ...over,
});

const member = (over: Partial<Member>): Member => ({
  bioguideId: "B001325",
  name: "Sheri Biggs",
  party: "R",
  chamber: "house",
  state: "SC",
  district: "SC-03",
  active: true,
  ...over,
});

describe("districtFromStateDst", () => {
  it("maps numbered districts", () => {
    expect(districtFromStateDst("SC03")).toEqual({ state: "SC", district: "SC-03" });
    expect(districtFromStateDst("TX26")).toEqual({ state: "TX", district: "TX-26" });
  });

  it("maps at-large 00 districts to -AL", () => {
    expect(districtFromStateDst("AK00")).toEqual({ state: "AK", district: "AK-AL" });
  });

  it("rejects malformed values", () => {
    expect(districtFromStateDst("Senate")).toBeNull();
  });
});

describe("resolveHouseMember", () => {
  const members: Member[] = [
    member({}),
    member({ bioguideId: "M001236", name: "Tim Moore", state: "NC", district: "NC-14" }),
    member({ bioguideId: "M001212", name: "Barry Moore", state: "AL", district: "AL-01" }),
    member({ bioguideId: "B001323", name: "Nick Begich III", state: "AK", district: "AK-AL" }),
    member({ bioguideId: "L000571", name: "Cynthia Lummis", chamber: "senate", state: "WY" }),
  ];

  it("matches by last name + state", () => {
    expect(resolveHouseMember(filing({}), members)?.bioguideId).toBe("B001325");
  });

  it("disambiguates shared surnames by state", () => {
    expect(
      resolveHouseMember(filing({ last: "Moore", first: "Tim", stateDst: "NC14" }), members)
        ?.bioguideId,
    ).toBe("M001236");
    expect(
      resolveHouseMember(filing({ last: "Moore", first: "Barry", stateDst: "AL01" }), members)
        ?.bioguideId,
    ).toBe("M001212");
  });

  it("matches suffixed roster names and at-large districts", () => {
    expect(
      resolveHouseMember(filing({ last: "Begich", first: "Nicholas", stateDst: "AK00" }), members)
        ?.bioguideId,
    ).toBe("B001323");
  });

  it("never matches senators and returns null for unknown filers", () => {
    expect(
      resolveHouseMember(filing({ last: "Lummis", first: "Cynthia", stateDst: "WY00" }), members),
    ).toBeNull();
    expect(
      resolveHouseMember(filing({ last: "Fleischmann", stateDst: "TN03" }), members),
    ).toBeNull();
  });
});

describe("buildSecurityResolver over config/universe.json", () => {
  const resolve = buildSecurityResolver(universe);

  it("resolves parenthesized exchange tickers", () => {
    expect(resolve("iShares Bitcoin Trust ETF (IBIT) [ST]")).toEqual({
      ticker: "IBIT",
      kind: "spot-etf",
    });
    expect(resolve("Strategy Inc. (MSTR) [ST]")).toEqual({ ticker: "MSTR", kind: "treasury" });
  });

  it("prefers the listed security when the literal BTC ticker collides", () => {
    // "(BTC)" in a filing is the Grayscale Mini Trust exchange ticker, never
    // a direct bitcoin holding.
    expect(resolve("Grayscale Bitcoin Mini Trust ETF (BTC) [ST]")).toEqual({
      ticker: "BTC",
      kind: "spot-etf",
    });
  });

  it("resolves direct bitcoin via name aliases", () => {
    expect(resolve("Bitcoin [CT]")).toEqual({ ticker: "BTC", kind: "direct" });
    expect(resolve("BTC-USD [CT]")).toEqual({ ticker: "BTC", kind: "direct" });
  });

  it("prefers the longest name match over the bare Bitcoin alias", () => {
    expect(resolve("FIDELITY WISE ORIGIN BITCOIN FUND [OT]")).toEqual({
      ticker: "FBTC",
      kind: "spot-etf",
    });
  });

  it("returns null outside the universe (Pelosi false-positive guard)", () => {
    expect(resolve("Block, Inc. (SQ) [ST]")).toBeNull();
    expect(resolve("APOLLO DEBT SOLUTIONS BDC CLASS S [OT]")).toBeNull();
  });
});

describe("parsePtrText on synthetic layout text", () => {
  it("handles partial sales, exchanges, self-owned rows and wrapped amounts", () => {
    const text = [
      "          JT          iShares Bitcoin Trust ETF (IBIT)      P                  01/10/2026 01/12/2026     $15,001 -",
      "                      [ST]                                                                               $50,000",
      "                      F      S        : New",
      "",
      "                      Bitcoin [CT]                          S (partial)        02/01/2026 02/02/2026     $1,001 - $15,000",
      "                      F      S        : New",
      "",
      "          SP          SPDR S&P 500 ETF (SPY) [EF]           E                  03/01/2026 03/02/2026     $1,001 - $15,000",
      "                      F      S        : New",
    ].join("\n");
    const rows = parsePtrText(text);
    expect(rows.length).toBe(3);
    expect(rows[0]).toMatchObject({
      ownerCode: "JT",
      typeCode: "P",
      amountLo: 15001,
      amountHi: 50000,
    });
    expect(rows[0]?.assetRaw).toBe("iShares Bitcoin Trust ETF (IBIT) [ST]");
    expect(rows[1]).toMatchObject({
      ownerCode: null,
      typeCode: "S",
      partial: true,
      amountLo: 1001,
      amountHi: 15000,
    });
    // Owner code SP is not confused with an asset starting "SPDR".
    expect(rows[2]).toMatchObject({ ownerCode: "SP", typeCode: "E" });
    expect(rows[2]?.assetRaw).toBe("SPDR S&P 500 ETF (SPY) [EF]");
  });
});
