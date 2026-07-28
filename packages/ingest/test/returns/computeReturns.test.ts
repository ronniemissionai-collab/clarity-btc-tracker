/**
 * End-to-end computeReturns over committed fixtures only - kadoa datasets
 * (live-fetched 2026-07-28) plus the live-captured SPY Yahoo chart and a
 * synthetic AAPL chart. No network: both fetch layers are stubbed.
 */
import { describe, expect, it } from "vitest";
import { isTrader, type Trade, type TradersConfig } from "@clarity-btc/shared";
import { computeReturns, type ComputeReturnsResult } from "../../src/returns/index.js";
import { fixtureFetchFn } from "../kadoa/helpers.js";
import { chartBody, makeTrade, spyChartBody, yahooFetchStub } from "./helpers.js";

const claims = [
  {
    quote: "Cited by congressional-trading trackers.",
    sourceUrl: "https://example.com/claim",
    attribution: "Test fixture",
  },
];

const roster: TradersConfig = {
  active: [
    { id: "M001243", name: "Dave McCormick", party: "R", chamber: "senate", claims },
    { id: "P000197", name: "Nancy Pelosi", party: "D", chamber: "house", claims },
    { id: "P000608", name: "Scott Peters", party: "D", chamber: "house", claims },
  ],
  watch: [],
};

/**
 * Merged trades as the pipeline would hand them over (step 3 output):
 * McCormick's BITB buys exist in the kadoa fixtures; Pelosi's options rows
 * carry null security resolution; Peters is official-only (no kadoa row).
 */
function mergedTrades(): Trade[] {
  return [
    // McCormick - two BITB buys matching kadoa fixture rows, plus one sell.
    makeTrade({
      memberId: "M001243",
      assetRaw: "Bitwise Bitcoin ETF",
      owner: "self",
      transactionDate: "2025-11-28",
      filedDate: "2025-12-26",
      range: { lo: 50001, hi: 100000 },
      security: { ticker: "BITB", kind: "spot-etf" },
    }),
    makeTrade({
      memberId: "M001243",
      assetRaw: "Bitwise Bitcoin ETF",
      owner: "self",
      transactionDate: "2025-11-25",
      filedDate: "2025-12-26",
      range: { lo: 15001, hi: 50000 },
      security: { ticker: "BITB", kind: "spot-etf" },
    }),
    makeTrade({
      memberId: "M001243",
      assetRaw: "Microsoft Corporation",
      owner: "self",
      side: "sell",
      transactionDate: "2026-01-15",
      filedDate: "2026-02-01",
      range: { lo: 15001, hi: 50000 },
    }),
    // Pelosi - kadoa asset_type "OP" (LEAPS); text alone looks like stock.
    makeTrade({
      memberId: "P000197",
      assetRaw: "Uber Technologies, Inc. Common Stock",
      owner: "spouse",
      transactionDate: "2026-05-29",
      filedDate: "2026-06-23",
      range: { lo: 500001, hi: 1000000 },
    }),
    // Pelosi - options by filing text.
    makeTrade({
      memberId: "P000197",
      assetRaw: "Alphabet Inc. - Class A Common Stock Call Options",
      owner: "spouse",
      transactionDate: "2026-05-29",
      filedDate: "2026-06-23",
      range: { lo: 1000001, hi: 5000000 },
    }),
    // Peters - official-only rows: AAPL prices via the chain, one unpriceable.
    makeTrade({
      memberId: "P000608",
      assetRaw: "Apple Inc. - Common Stock (AAPL)",
      owner: "spouse",
      transactionDate: "2026-05-05",
      filedDate: "2026-05-20",
      range: { lo: 1001, hi: 15000 },
    }),
    makeTrade({
      memberId: "P000608",
      assetRaw: "Gorguze Family Holdings LLC",
      owner: "spouse",
      transactionDate: "2026-05-05",
      filedDate: "2026-05-20",
      range: { lo: 100001, hi: 250000 },
    }),
  ];
}

async function run(yahooCalls?: string[]): Promise<ComputeReturnsResult> {
  return computeReturns(roster, mergedTrades(), {
    asOf: "2026-07-28",
    kadoa: { fetchFn: fixtureFetchFn(), cacheDir: null },
    yahoo: {
      cacheDir: null,
      fetchFn: yahooFetchStub(
        {
          SPY: spyChartBody(),
          AAPL: chartBody("AAPL", [
            { date: "2026-05-05", close: 300 },
            { date: "2026-07-24", close: 330 },
          ]),
        },
        yahooCalls,
      ),
    },
  });
}

describe("computeReturns", () => {
  it("emits schema-valid traders.json rows ranked by trade count", async () => {
    const result = await run();
    expect(result.traders).toHaveLength(3);
    for (const trader of result.traders) expect(isTrader(trader)).toBe(true);
    expect(result.traders.map((t) => t.memberId)).toEqual(["M001243", "P000197", "P000608"]);
    expect(result.traders.map((t) => t.tradeCount)).toEqual([3, 2, 2]);
    // Claims pass through from the config untouched.
    expect(result.traders[0]?.claims).toEqual(claims);
    // Computations stay aligned with the trader rows.
    expect(result.computations.map((c) => c.memberId)).toEqual(
      result.traders.map((t) => t.memberId),
    );
  });

  it("uses kadoa's precomputed per-trade returns as the primary source", async () => {
    const yahooCalls: string[] = [];
    const result = await run(yahooCalls);
    const mccormick = result.traders.find((t) => t.memberId === "M001243");
    // Midpoint-weighted mean of the two matched kadoa rows:
    // (75000.5 * -28.629156 + 32500.5 * -25.863310) / 107501 = -27.79296...
    expect(mccormick?.measured?.return).toBe(-27.8);
    expect(mccormick?.measured?.excess).toBe(-36.1);
    expect(mccormick?.measured?.method).toBe("midpoint");
    expect(mccormick?.measured?.benchmark).toBe("SPY");
    expect(mccormick?.measured?.asOf).toBe("2026-07-28");
    expect(mccormick?.measured?.window).toBe(
      "disclosed buys 2025-11-25 to 2025-11-28, since-trade, midpoint-weighted",
    );
    // Every figure labeled an estimate.
    expect(mccormick?.measured?.note).toContain("Estimate");
    expect(mccormick?.attribution).toBe("self");

    const points = result.computations.find((c) => c.memberId === "M001243")?.points;
    expect(points?.map((p) => p.source)).toEqual(["kadoa", "kadoa"]);
    expect(points?.map((p) => p.midpoint)).toEqual([32500.5, 75000.5]);
    // kadoa-scored tickers never hit Yahoo.
    expect(yahooCalls.some((u) => u.includes("/chart/BITB"))).toBe(false);
  });

  it("falls back to chain pricing (kadoa latest close + Yahoo history) with SPY excess", async () => {
    const yahooCalls: string[] = [];
    const result = await run(yahooCalls);
    const peters = result.traders.find((t) => t.memberId === "P000608");
    // Entry: Yahoo synthetic AAPL 300 @ 2026-05-05. Current: kadoa prices.json
    // latest 336.70001220703125 (chain prefers kadoa for the current close).
    // ret = (336.70001.../300 - 1)*100 = 12.2333...
    // SPY same window: entry 721.9102... (Yahoo fixture adjclose 2026-05-05),
    // current 737.0999... (kadoa) -> +2.1041...%; excess = 10.129... -> 10.1
    expect(peters?.measured?.return).toBe(12.2);
    expect(peters?.measured?.excess).toBe(10.1);
    expect(peters?.measured?.note).toContain("1 unpriceable position(s) excluded");

    const comp = result.computations.find((c) => c.memberId === "P000608");
    expect(comp?.points).toHaveLength(1);
    expect(comp?.points[0]?.ticker).toBe("AAPL");
    expect(comp?.points[0]?.source).toBe("yahoo");
    expect(comp?.points[0]?.ret).toBeCloseTo(12.233337402343757, 6);
    expect(comp?.points[0]?.excess).toBeCloseTo(10.129231110857194, 6);
    // The LLC row has no ticker anywhere -> excluded and counted.
    expect(comp?.unpriceable).toHaveLength(1);
    expect(comp?.unpriceable[0]?.reason).toContain("no listed ticker");

    // Fallback order: AAPL + SPY history each fetched from Yahoo exactly once.
    const symbols = yahooCalls
      .map((u) => /\/chart\/([^?]+)/.exec(u)?.[1])
      .filter((s): s is string => s !== undefined)
      .sort();
    expect(symbols).toEqual(["AAPL", "SPY"]);
  });

  it("excludes options positions (Pelosi LEAPS) and reports why nothing was measured", async () => {
    const result = await run();
    const pelosi = result.traders.find((t) => t.memberId === "P000197");
    expect(pelosi?.measured).toBeNull();
    expect(pelosi?.note).toContain("Not measured");
    expect(pelosi?.note).toContain("2 options position(s)");
    expect(pelosi?.attribution).toBe("spouse");

    const comp = result.computations.find((c) => c.memberId === "P000197");
    expect(comp?.points).toEqual([]);
    expect(comp?.unpriceable).toHaveLength(2);
    for (const u of comp?.unpriceable ?? []) {
      expect(u.reason).toContain("options position");
    }
    // The UBER row is only knowable as options via kadoa's asset_type "OP".
    expect(comp?.unpriceable.map((u) => u.assetRaw)).toContain(
      "Uber Technologies, Inc. Common Stock",
    );
  });

  it("keeps working without kadoa (Yahoo-only) and records a warning", async () => {
    const result = await computeReturns(roster, mergedTrades(), {
      asOf: "2026-07-28",
      kadoa: {
        cacheDir: null,
        fetchFn: () =>
          Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("down") }),
      },
      yahoo: {
        cacheDir: null,
        fetchFn: yahooFetchStub({
          SPY: spyChartBody(),
          AAPL: chartBody("AAPL", [
            { date: "2026-05-05", close: 300 },
            { date: "2026-07-24", close: 330 },
          ]),
        }),
      },
    });
    expect(result.warnings.length).toBeGreaterThanOrEqual(2); // returns + prices
    // Peters still prices fully via Yahoo (current close 330 now, not kadoa's).
    const peters = result.traders.find((t) => t.memberId === "P000608");
    expect(peters?.measured?.return).toBe(10);
    // McCormick's BITB rows lose their kadoa returns and fall back to Yahoo,
    // which has no BITB series in this stub -> unpriceable, measured null.
    const mccormick = result.traders.find((t) => t.memberId === "M001243");
    expect(mccormick?.measured).toBeNull();
    expect(mccormick?.note).toContain("Not measured");
  });

  it("reports members with no merged trades honestly", async () => {
    const result = await computeReturns(
      { active: [roster.active[0]!], watch: [] },
      [],
      {
        asOf: "2026-07-28",
        kadoa: { fetchFn: fixtureFetchFn(), cacheDir: null },
        yahoo: { cacheDir: null, fetchFn: yahooFetchStub({}) },
      },
    );
    const trader = result.traders[0];
    expect(trader?.tradeCount).toBe(0);
    expect(trader?.measured).toBeNull();
    expect(trader?.note).toContain("no merged trades");
    expect(trader?.attribution).toBe("self (owner not stated in filings)");
  });
});
