import { describe, expect, it } from "vitest";
import {
  HoldingSchema,
  isMember,
  isTrade,
  parseMember,
  securityKey,
} from "../src/index.js";

const validMember = {
  bioguideId: "P000197",
  name: "Nancy Pelosi",
  party: "D",
  chamber: "house",
  state: "CA",
  district: "CA-11",
  active: true,
};

describe("type guards", () => {
  it("isMember accepts a valid member and rejects junk", () => {
    expect(isMember(validMember)).toBe(true);
    expect(isMember({ ...validMember, party: "X" })).toBe(false);
    expect(isMember({ ...validMember, bioguideId: "nope" })).toBe(false);
    expect(isMember(null)).toBe(false);
  });

  it("isTrade rejects a trade with an inverted range", () => {
    expect(
      isTrade({
        memberId: "P000197",
        assetRaw: "AAPL",
        security: null,
        side: "buy",
        range: { lo: 50000, hi: 15000 },
        transactionDate: "2026-01-02",
        filedDate: "2026-01-20",
        docUrl: "https://disclosures-clerk.house.gov/x.pdf",
        late: false,
      }),
    ).toBe(false);
  });
});

describe("parse helpers", () => {
  it("parseMember throws on invalid input", () => {
    expect(() => parseMember({})).toThrow();
    expect(parseMember(validMember).name).toBe("Nancy Pelosi");
  });
});

describe("securityKey", () => {
  it("disambiguates direct BTC from the Grayscale Mini Trust ticker collision", () => {
    expect(securityKey({ ticker: "BTC", kind: "direct" })).toBe("BTC:direct");
    expect(securityKey({ ticker: "BTC", kind: "spot-etf" })).toBe("BTC:spot-etf");
    expect(securityKey({ ticker: "BTC", kind: "direct" })).not.toBe(
      securityKey({ ticker: "BTC", kind: "spot-etf" }),
    );
  });
});

describe("HoldingSchema source rules", () => {
  const base = {
    memberId: "M001243",
    security: { ticker: "BITB", kind: "spot-etf" },
    owner: "self",
    range: { lo: 1000001, hi: 1600000 },
    status: "holds",
    asOf: "2025-12-29",
    extraction: "efd-html",
    verification: "corroborated",
  };

  it("requires at least one official filing source", () => {
    const newsOnly = {
      ...base,
      sources: [{ kind: "news", url: "https://example.com/story" }],
    };
    expect(HoldingSchema.safeParse(newsOnly).success).toBe(false);

    const withFiling = {
      ...base,
      sources: [
        { kind: "filing", url: "https://efdsearch.senate.gov/search/view/ptr/abc/" },
        { kind: "news", url: "https://example.com/story" },
      ],
    };
    expect(HoldingSchema.safeParse(withFiling).success).toBe(true);
  });

  it("rejects an empty sources array", () => {
    expect(HoldingSchema.safeParse({ ...base, sources: [] }).success).toBe(false);
  });
});
