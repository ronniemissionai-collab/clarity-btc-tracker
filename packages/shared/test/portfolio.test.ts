/**
 * v1.1 portfolio contract (build ticket 14): round-trip of a portfolio file
 * and index through the shared parsers, the widened security kind, and the
 * new optional Trader.series field.
 */
import { describe, expect, it } from "vitest";
import {
  parsePortfolioFile,
  parsePortfolioIndex,
  parseTrader,
  securityKey,
  type PortfolioFile,
  type PortfolioIndexEntry,
} from "../src/index.js";

const FILING_URL = "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034195.pdf";

const member = {
  bioguideId: "P000197",
  name: "Nancy Pelosi",
  party: "D",
  chamber: "house",
  state: "CA",
  district: "CA-11",
  active: true,
  traderRoster: "active",
} as const;

/** A universe position and a non-universe ("other" kind) position. */
const positions = [
  {
    memberId: "P000197",
    security: { ticker: "IBIT", kind: "spot-etf" },
    owner: "spouse",
    range: { lo: 500001, hi: 1000000 },
    status: "holds",
    asOf: "2026-06-20",
    extraction: "pdf-text",
    verification: "unverified",
    sources: [{ kind: "filing", url: FILING_URL }],
  },
  {
    memberId: "P000197",
    security: { ticker: "AAPL", kind: "other" },
    owner: "spouse",
    range: { lo: 1000001, hi: 5000000 },
    status: "holds",
    asOf: "2026-05-02",
    extraction: "pdf-text",
    verification: "unverified",
    sources: [{ kind: "filing", url: FILING_URL }],
  },
];

const trades = [
  {
    memberId: "P000197",
    assetRaw: "iShares Bitcoin Trust ETF (IBIT) [ST]",
    security: { ticker: "IBIT", kind: "spot-etf" },
    side: "buy",
    owner: "spouse",
    range: { lo: 500001, hi: 1000000 },
    transactionDate: "2026-06-20",
    filedDate: "2026-07-02",
    docUrl: FILING_URL,
    late: false,
    provenance: "official", // extra key: parser must tolerate + strip it
  },
  {
    memberId: "P000197",
    assetRaw: "Apple Inc. - Common Stock (AAPL) [ST]",
    security: null,
    side: "buy",
    owner: "spouse",
    range: { lo: 1000001, hi: 5000000 },
    transactionDate: "2026-05-02",
    filedDate: "2026-05-20",
    docUrl: FILING_URL,
    late: false,
  },
];

const portfolioFile = {
  member,
  positions,
  trades, // newest first
  series: [
    { date: "2026-05-02", value: 3000000.5 },
    { date: "2026-06-20", value: 750000.5 },
  ],
  measured: {
    return: 16.8,
    excess: 4.2,
    method: "midpoint",
    benchmark: "SPY",
    window: "disclosed buys 2026-05-02 to 2026-06-20, since-trade, midpoint-weighted",
    asOf: "2026-07-28",
  },
};

const indexEntry = {
  memberId: "P000197",
  name: "Nancy Pelosi",
  party: "D",
  chamber: "house",
  state: "CA",
  active: true,
  tradeCount: 2,
  lastTradeDate: "2026-06-20",
  rosterMember: true,
};

describe("PortfolioFile contract", () => {
  it("round-trips through serialization and the shared parser", () => {
    const parsed: PortfolioFile = parsePortfolioFile(
      JSON.parse(JSON.stringify(portfolioFile)),
    );
    expect(parsed.member.bioguideId).toBe("P000197");
    expect(parsed.positions).toHaveLength(2);
    expect(parsed.trades).toHaveLength(2);
    expect(parsed.series).toEqual(portfolioFile.series);
    expect(parsed.measured?.return).toBe(16.8);
    // The provenance extra key is tolerated and stripped on parse.
    expect("provenance" in parsed.trades[0]!).toBe(false);
    // Reserialize-and-reparse is stable (what writeOutputsAtomically enforces).
    expect(parsePortfolioFile(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("accepts measured: null for non-roster members", () => {
    const parsed = parsePortfolioFile({ ...portfolioFile, measured: null });
    expect(parsed.measured).toBeNull();
  });

  it("widens the security kind with 'other' and keys it distinctly", () => {
    const other = parsePortfolioFile(portfolioFile).positions[1]!;
    expect(other.security.kind).toBe("other");
    expect(securityKey(other.security)).toBe("AAPL:other");
  });

  it("keeps holdings.json epistemics: positions without a filing source fail", () => {
    const newsOnly = {
      ...portfolioFile,
      positions: [
        {
          ...positions[1]!,
          sources: [{ kind: "news", url: "https://example.com/story" }],
        },
      ],
    };
    expect(() => parsePortfolioFile(newsOnly)).toThrow();
  });

  it("rejects an unknown security kind and a bad series date", () => {
    expect(() =>
      parsePortfolioFile({
        ...portfolioFile,
        positions: [{ ...positions[1]!, security: { ticker: "AAPL", kind: "equity" } }],
      }),
    ).toThrow();
    expect(() =>
      parsePortfolioFile({ ...portfolioFile, series: [{ date: "06/20/2026", value: 1 }] }),
    ).toThrow();
  });
});

describe("PortfolioIndexEntry contract", () => {
  it("round-trips an index through the shared parser", () => {
    const parsed: PortfolioIndexEntry[] = parsePortfolioIndex(
      JSON.parse(JSON.stringify([indexEntry])),
    );
    expect(parsed).toEqual([indexEntry]);
  });

  it("requires >= 1 trade and a full directory row", () => {
    expect(() => parsePortfolioIndex([{ ...indexEntry, tradeCount: 0 }])).toThrow();
    expect(() => parsePortfolioIndex([{ ...indexEntry, rosterMember: undefined }])).toThrow();
    expect(() => parsePortfolioIndex([{ ...indexEntry, state: "CAL" }])).toThrow();
  });
});

describe("Trader.series (v1.1 optional field)", () => {
  const trader = {
    memberId: "P000197",
    tradeCount: 2,
    claims: [],
    measured: null,
    attribution: "spouse",
  };

  it("stays optional (pre-v1.1 rows and frozen fixtures parse unchanged)", () => {
    expect(parseTrader(trader).series).toBeUndefined();
  });

  it("parses precomputed sparkline points", () => {
    const parsed = parseTrader({
      ...trader,
      series: [{ date: "2026-06-20", value: 750000.5 }],
    });
    expect(parsed.series).toEqual([{ date: "2026-06-20", value: 750000.5 }]);
  });
});
