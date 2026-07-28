import { describe, expect, it } from "vitest";
import type { Holding, Security, Trade } from "@clarity-btc/shared";
import { deriveHoldings } from "../../src/holdings/index.js";
import type { MergedTrade } from "../../src/kadoa/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UNIVERSE: Security[] = [
  {
    ticker: "BTC",
    name: "Bitcoin (direct holding)",
    tier: 1,
    kind: "direct",
    aliases: ["Bitcoin", "BTC-USD"],
  },
  { ticker: "BTC", name: "Grayscale Bitcoin Mini Trust ETF", tier: 1, kind: "spot-etf" },
  { ticker: "IBIT", name: "iShares Bitcoin Trust ETF", tier: 1, kind: "spot-etf" },
  { ticker: "BITB", name: "Bitwise Bitcoin ETF", tier: 1, kind: "spot-etf" },
  { ticker: "MSTR", name: "Strategy Inc.", tier: 1, kind: "treasury" },
  { ticker: "COIN", name: "Coinbase Global, Inc.", tier: 2, kind: "exchange" },
];

const HOUSE_DOC = "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030001.pdf";
const SENATE_DOC = "https://efdsearch.senate.gov/search/view/ptr/aaaa-bbbb-cccc/";
const ANNUAL_DOC = "https://efdsearch.senate.gov/search/view/annual/dddd-eeee-ffff/";

const NOW = "2025-12-31";

function annual(overrides: Partial<Holding> = {}): Holding {
  return {
    memberId: "L000571",
    security: { ticker: "BTC", kind: "direct" },
    owner: "trust",
    range: { lo: 100001, hi: 250000 },
    status: "holds",
    asOf: "2025-08-13",
    extraction: "efd-html",
    verification: "unverified",
    sources: [{ kind: "filing", url: ANNUAL_DOC, title: "Annual report (2024)" }],
    ...overrides,
  };
}

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    memberId: "G000603",
    assetRaw: "Bitcoin",
    security: { ticker: "BTC", kind: "direct" },
    side: "buy",
    range: { lo: 500001, hi: 1000000 },
    transactionDate: "2025-06-20",
    filedDate: "2025-07-10",
    docUrl: HOUSE_DOC,
    late: false,
    ...overrides,
  };
}

function derive(baseline: Holding[], trades: Trade[]) {
  return deriveHoldings({ baseline, trades, universe: UNIVERSE, now: NOW });
}

// ---------------------------------------------------------------------------
// Buys
// ---------------------------------------------------------------------------

describe("deriveHoldings - buys", () => {
  it("creates a position from a PTR buy with no annual baseline", () => {
    const { holdings, rejects } = derive([], [trade()]);
    expect(rejects).toEqual([]);
    expect(holdings).toHaveLength(1);
    const row = holdings[0]!;
    expect(row.memberId).toBe("G000603");
    expect(row.security).toEqual({ ticker: "BTC", kind: "direct" });
    expect(row.owner).toBe("self"); // trades without an owner default to self
    expect(row.range).toEqual({ lo: 500001, hi: 1000000 });
    expect(row.status).toBe("holds");
    expect(row.asOf).toBe("2025-06-20");
    expect(row.verification).toBe("unverified");
    expect(row.extraction).toBe("pdf-text"); // Clerk PDF channel
    expect(row.sources).toEqual([{ kind: "filing", url: HOUSE_DOC }]);
  });

  it("marks senate-channel rows as efd-html extraction", () => {
    const { holdings } = derive([], [trade({ docUrl: SENATE_DOC })]);
    expect(holdings[0]?.extraction).toBe("efd-html");
  });

  it("extends an annual baseline: lo and hi summed separately, source appended", () => {
    const buy = trade({
      memberId: "L000571",
      owner: "trust",
      range: { lo: 50001, hi: 100000 },
      transactionDate: "2025-09-15",
    });
    const { holdings } = derive([annual()], [buy]);
    expect(holdings).toHaveLength(1);
    const row = holdings[0]!;
    expect(row.range).toEqual({ lo: 150002, hi: 350000 });
    expect(row.asOf).toBe("2025-09-15");
    expect(row.sources.map((s) => s.url)).toEqual([ANNUAL_DOC, HOUSE_DOC]);
  });

  it("ignores PTRs dated on or before the annual as-of date (no double count)", () => {
    const alreadyReflected = trade({
      memberId: "L000571",
      owner: "trust",
      transactionDate: "2025-08-13",
    });
    const older = trade({
      memberId: "L000571",
      owner: "trust",
      transactionDate: "2025-03-01",
    });
    const { holdings } = derive([annual()], [alreadyReflected, older]);
    expect(holdings[0]?.range).toEqual({ lo: 100001, hi: 250000 });
    expect(holdings[0]?.asOf).toBe("2025-08-13");
  });

  it("aggregates repeated buys per member+security by summing lo and hi", () => {
    const buys = [
      trade({ range: { lo: 100001, hi: 250000 }, transactionDate: "2025-03-24" }),
      trade({ range: { lo: 250001, hi: 500000 }, transactionDate: "2025-03-27" }),
      trade({ range: { lo: 100001, hi: 250000 }, transactionDate: "2025-06-20" }),
    ];
    const { holdings } = derive([], buys);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.range).toEqual({ lo: 450003, hi: 1000000 });
    expect(holdings[0]?.asOf).toBe("2025-06-20");
  });

  it("keeps owner attribution: self and spouse are distinct rows", () => {
    const buys = [
      trade({ owner: "self", range: { lo: 15001, hi: 50000 } }),
      trade({ owner: "spouse", range: { lo: 50001, hi: 100000 }, transactionDate: "2025-12-18" }),
    ];
    const { holdings } = derive([], buys);
    expect(holdings).toHaveLength(2);
    expect(holdings.map((h) => [h.owner, h.range.lo])).toEqual([
      ["self", 15001],
      ["spouse", 50001],
    ]);
  });

  it("tracks the BTC composite-key collision as two distinct positions", () => {
    const buys = [
      trade({ security: { ticker: "BTC", kind: "direct" } }),
      trade({
        security: { ticker: "BTC", kind: "spot-etf" },
        assetRaw: "Grayscale Bitcoin Mini Trust ETF (BTC)",
        range: { lo: 1001, hi: 15000 },
      }),
    ];
    const { holdings } = derive([], buys);
    expect(holdings).toHaveLength(2);
    expect(holdings.map((h) => h.security.kind).sort()).toEqual(["direct", "spot-etf"]);
  });

  it("accepts provenance-stamped merged trades unchanged", () => {
    const merged: MergedTrade = { ...trade(), provenance: "both" };
    const { holdings } = deriveHoldings({ trades: [merged], universe: UNIVERSE, now: NOW });
    expect(holdings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

describe("deriveHoldings - sales", () => {
  it("marks a tracked position sold on a full sale, keeping the exited range", () => {
    const sale = trade({
      memberId: "L000571",
      owner: "trust",
      side: "sell",
      range: { lo: 100001, hi: 250000 },
      transactionDate: "2026-01-10",
    });
    const { holdings } = derive([annual()], [sale]);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.status).toBe("sold");
    expect(holdings[0]?.asOf).toBe("2026-01-10");
    expect(holdings[0]?.range).toEqual({ lo: 100001, hi: 250000 });
  });

  it("records a PTR-only full sale as a sold row (Reschenthaler case)", () => {
    const sale = trade({
      memberId: "R000610",
      side: "sell",
      range: { lo: 1001, hi: 15000 },
      transactionDate: "2025-04-24",
    });
    const { holdings, rejects } = derive([], [sale]);
    expect(rejects).toEqual([]);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.status).toBe("sold");
    expect(holdings[0]?.range).toEqual({ lo: 1001, hi: 15000 });
    expect(holdings[0]?.asOf).toBe("2025-04-24");
  });

  it("recomputes the range conservatively on a partial sale", () => {
    // Baseline 100,001-250,000; partial sale of 15,001-50,000.
    // Conservative remainder: lo = 100,001-50,000, hi = 250,000-15,001.
    const sale = trade({
      memberId: "L000571",
      owner: "trust",
      side: "sell",
      range: { lo: 15001, hi: 50000 },
      transactionDate: "2026-02-01",
      note: "partial sale",
    });
    const { holdings } = derive([annual()], [sale]);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.status).toBe("holds");
    expect(holdings[0]?.range).toEqual({ lo: 50001, hi: 234999 });
    expect(holdings[0]?.note).toContain("partial sale 2026-02-01");
  });

  it("marks the position sold when partial sales exhaust the disclosed range", () => {
    const sale = trade({
      memberId: "L000571",
      owner: "trust",
      side: "sell",
      range: { lo: 250001, hi: 500000 },
      transactionDate: "2026-02-01",
      note: "partial sale",
    });
    const { holdings } = derive([annual()], [sale]);
    expect(holdings[0]?.status).toBe("sold");
    expect(holdings[0]?.note).toContain("exhausted");
  });

  it("rejects a partial sale with no known position (missed baseline)", () => {
    const sale = trade({ side: "sell", note: "partial sale" });
    const { holdings, rejects } = derive([], [sale]);
    expect(holdings).toEqual([]);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]?.memberId).toBe("G000603");
    expect(rejects[0]?.reason).toMatch(/partial sale .* without a known position/);
  });

  it("reopens a fresh position when a buy follows a full sale", () => {
    const trades = [
      trade({ transactionDate: "2025-03-01", range: { lo: 1001, hi: 15000 } }),
      trade({ side: "sell", transactionDate: "2025-04-24", range: { lo: 1001, hi: 15000 } }),
      trade({ transactionDate: "2025-06-20", range: { lo: 15001, hi: 50000 } }),
    ];
    const { holdings } = derive([], trades);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.status).toBe("holds");
    expect(holdings[0]?.range).toEqual({ lo: 15001, hi: 50000 });
    expect(holdings[0]?.asOf).toBe("2025-06-20");
  });

  it("applies trades chronologically regardless of input order", () => {
    const trades = [
      trade({ side: "sell", transactionDate: "2025-04-24", range: { lo: 1001, hi: 15000 } }),
      trade({ transactionDate: "2025-03-01", range: { lo: 1001, hi: 15000 } }),
    ];
    const { holdings } = derive([], trades);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.status).toBe("sold");
  });
});

// ---------------------------------------------------------------------------
// Baseline handling, universe filtering, staleness, rejects
// ---------------------------------------------------------------------------

describe("deriveHoldings - baseline and filtering", () => {
  it("keeps only the latest annual per member+security+owner", () => {
    const old = annual({ asOf: "2024-08-13", range: { lo: 50001, hi: 100000 } });
    const latest = annual({ asOf: "2025-08-13", range: { lo: 100001, hi: 250000 } });
    const { holdings } = derive([old, latest], []);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.range).toEqual({ lo: 100001, hi: 250000 });
  });

  it("sums same-day annual rows for one member+security+owner (two accounts)", () => {
    const a = annual({ range: { lo: 100001, hi: 250000 } });
    const b = annual({
      range: { lo: 100001, hi: 250000 },
      sources: [{ kind: "filing", url: `${ANNUAL_DOC}part-2/` }],
    });
    const { holdings } = derive([a, b], []);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.range).toEqual({ lo: 200002, hi: 500000 });
    expect(holdings[0]?.sources).toHaveLength(2);
  });

  it("filters non-universe securities from both baseline and trades", () => {
    const outside = annual({
      security: { ticker: "SQ", kind: "exchange" },
    });
    const unresolved = trade({ security: null, assetRaw: "Apple Inc (AAPL)" });
    const nonUniverse = trade({ security: { ticker: "AAPL", kind: "exchange" } });
    const { holdings, rejects } = derive([outside], [unresolved, nonUniverse]);
    expect(holdings).toEqual([]);
    expect(rejects).toEqual([]);
  });

  it("marks a holds row stale when no filing confirmed it within a year", () => {
    const { holdings } = derive([annual({ asOf: "2024-08-13" })], []);
    expect(holdings[0]?.status).toBe("stale");
  });

  it("does not mark sold rows stale", () => {
    const sale = trade({
      memberId: "L000571",
      owner: "trust",
      side: "sell",
      transactionDate: "2025-01-10",
      range: { lo: 100001, hi: 250000 },
    });
    const { holdings } = derive([annual({ asOf: "2024-08-13" })], [sale]);
    expect(holdings[0]?.status).toBe("sold");
  });

  it("respects a custom staleAfterDays", () => {
    const { holdings } = deriveHoldings({
      baseline: [annual({ asOf: "2025-11-01" })],
      universe: UNIVERSE,
      now: NOW,
      staleAfterDays: 10,
    });
    expect(holdings[0]?.status).toBe("stale");
  });

  it("rejects a baseline row without an official filing source", () => {
    const invalid = {
      ...annual(),
      sources: [{ kind: "news", url: "https://bitcoinpoliticians.org/" }],
    } as unknown as Holding;
    const { holdings, rejects } = derive([invalid], []);
    expect(holdings).toEqual([]);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]?.memberId).toBe("L000571");
    expect(rejects[0]?.reason).toContain("filing");
  });

  it("keeps the least-reliable extraction when merging channels", () => {
    const ocrBaseline = annual({ extraction: "pdf-ocr" });
    const buy = trade({
      memberId: "L000571",
      owner: "trust",
      transactionDate: "2025-09-15",
      docUrl: SENATE_DOC,
    });
    const { holdings } = derive([ocrBaseline], [buy]);
    expect(holdings[0]?.extraction).toBe("pdf-ocr");
  });

  it("always emits verification 'unverified' for the Exa step to upgrade", () => {
    const corroborated = annual({ verification: "corroborated" });
    const { holdings } = derive([corroborated], []);
    expect(holdings[0]?.verification).toBe("unverified");
  });
});
