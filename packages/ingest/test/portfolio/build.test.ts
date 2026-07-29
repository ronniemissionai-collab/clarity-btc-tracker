/**
 * v1.1 portfolio emission (build ticket 14): all-ticker trade resolution,
 * trades.json slimming, sparkline series, unfiltered position derivation via
 * the holdings machinery, and the index/file invariant.
 */
import { describe, expect, it } from "vitest";
import type { Member, Trade, Trader } from "@clarity-btc/shared";
import { parsePortfolioFile, parsePortfolioIndex } from "@clarity-btc/shared";
import {
  attachTraderSeries,
  buildPortfolios,
  resolveAllTickerTrades,
  slimTrades,
  tradeSeries,
} from "../../src/portfolio/index.js";
import { derivePortfolioPositions } from "../../src/holdings/index.js";
import type { TraderComputation } from "../../src/returns/index.js";

const HOUSE_DOC = "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20030001.pdf";

const MEMBERS: Member[] = [
  {
    bioguideId: "P000197",
    name: "Nancy Pelosi",
    party: "D",
    chamber: "house",
    state: "CA",
    active: true,
  },
  {
    bioguideId: "G000603",
    name: "Marjorie Taylor Greene",
    party: "R",
    chamber: "house",
    state: "GA",
    active: true,
  },
];

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    memberId: "P000197",
    assetRaw: "Apple Inc. - Common Stock (AAPL) [ST]",
    security: null,
    side: "buy",
    owner: "spouse",
    range: { lo: 1000001, hi: 5000000 },
    transactionDate: "2026-05-02",
    filedDate: "2026-05-20",
    docUrl: HOUSE_DOC,
    late: false,
    ...overrides,
  };
}

const UNIVERSE_TRADE = trade({
  memberId: "G000603",
  assetRaw: "iShares Bitcoin Trust ETF (IBIT) [ST]",
  security: { ticker: "IBIT", kind: "spot-etf" },
  side: "buy",
  owner: "self",
  range: { lo: 1001, hi: 15000 },
  transactionDate: "2026-06-20",
  filedDate: "2026-07-01",
});

const MUNI_TRADE = trade({
  assetRaw: "PITTSBURGH PA WTR & SWR AUTH WTR & SWR",
  transactionDate: "2026-03-10",
  filedDate: "2026-03-30",
});

describe("resolveAllTickerTrades", () => {
  it("keeps universe refs, synthesizes 'other' refs, surfaces the rest", () => {
    const { resolved, unresolved } = resolveAllTickerTrades([
      UNIVERSE_TRADE,
      trade(),
      MUNI_TRADE,
    ]);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.security).toEqual({ ticker: "IBIT", kind: "spot-etf" });
    expect(resolved[1]!.security).toEqual({ ticker: "AAPL", kind: "other" });
    expect(unresolved).toEqual([MUNI_TRADE]);
  });
});

describe("slimTrades (v1.1 trades.json)", () => {
  it("keeps exactly the universe-resolved rows, in order", () => {
    const aapl = trade();
    expect(slimTrades([aapl, UNIVERSE_TRADE, MUNI_TRADE])).toEqual([UNIVERSE_TRADE]);
  });

  it("preserves extra fields (provenance) on the surviving rows", () => {
    const merged = [{ ...UNIVERSE_TRADE, provenance: "both" as const }];
    expect(slimTrades(merged)[0]!.provenance).toBe("both");
  });
});

describe("tradeSeries", () => {
  it("emits range-midpoint points ascending by transaction date", () => {
    expect(tradeSeries([UNIVERSE_TRADE, MUNI_TRADE, trade()])).toEqual([
      { date: "2026-03-10", value: 3000000.5 },
      { date: "2026-05-02", value: 3000000.5 },
      { date: "2026-06-20", value: 8000.5 },
    ]);
  });
});

describe("attachTraderSeries", () => {
  const trader: Trader = {
    memberId: "P000197",
    tradeCount: 2,
    claims: [],
    measured: null,
    attribution: "spouse",
  };

  it("maps the returns computation points onto the trader rows", () => {
    const computations: TraderComputation[] = [
      {
        memberId: "P000197",
        points: [
          { date: "2026-05-02", ticker: "AAPL", midpoint: 3000000.5, ret: 12, excess: 3, source: "yahoo" },
        ],
        unpriceable: [],
      },
    ];
    const [withSeries] = attachTraderSeries([trader], computations);
    expect(withSeries!.series).toEqual([{ date: "2026-05-02", value: 3000000.5 }]);
  });

  it("gives a trader without scored points an honest empty series", () => {
    const [withSeries] = attachTraderSeries([trader], []);
    expect(withSeries!.series).toEqual([]);
  });
});

describe("derivePortfolioPositions (holdings machinery, no universe filter)", () => {
  it("forms positions for non-universe tickers with full epistemics", () => {
    const { resolved } = resolveAllTickerTrades([trade(), UNIVERSE_TRADE]);
    const { positions, rejects } = derivePortfolioPositions({
      trades: resolved,
      now: "2026-07-28",
    });
    expect(rejects).toEqual([]);
    expect(positions).toHaveLength(2);
    const aapl = positions.find((p) => p.security.ticker === "AAPL")!;
    expect(aapl.security.kind).toBe("other");
    expect(aapl.owner).toBe("spouse");
    expect(aapl.status).toBe("holds");
    expect(aapl.range).toEqual({ lo: 1000001, hi: 5000000 });
    expect(aapl.verification).toBe("unverified");
    expect(aapl.sources).toEqual([{ kind: "filing", url: HOUSE_DOC }]);
  });

  it("still counts rejects (partial sale without a known position)", () => {
    const { resolved } = resolveAllTickerTrades([
      trade({ side: "sell", note: "partial sale" }),
    ]);
    const { positions, rejects } = derivePortfolioPositions({
      trades: resolved,
      now: "2026-07-28",
    });
    expect(positions).toEqual([]);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.reason).toContain("partial sale");
  });
});

describe("buildPortfolios", () => {
  const trades: Trade[] = [trade(), MUNI_TRADE, UNIVERSE_TRADE];
  const measured: Trader["measured"] = {
    return: 16.8,
    method: "midpoint",
    benchmark: "SPY",
  };

  const result = buildPortfolios({
    members: MEMBERS,
    trades,
    rosterIds: new Set(["P000197"]),
    measuredById: new Map([["P000197", measured]]),
    now: "2026-07-28",
  });

  it("emits one file + one index row per member with >= 1 trade (invariant)", () => {
    expect(result.index).toHaveLength(2);
    expect(result.files).toHaveLength(2);
    expect(new Set(result.index.map((e) => e.memberId))).toEqual(
      new Set(result.files.map((f) => f.memberId)),
    );
  });

  it("index rows carry directory metadata, sorted by tradeCount then name", () => {
    expect(parsePortfolioIndex(JSON.parse(JSON.stringify(result.index)))).toEqual(result.index);
    expect(result.index[0]).toEqual({
      memberId: "P000197",
      name: "Nancy Pelosi",
      party: "D",
      chamber: "house",
      state: "CA",
      active: true,
      tradeCount: 2,
      lastTradeDate: "2026-05-02",
      rosterMember: true,
    });
    expect(result.index[1]!.memberId).toBe("G000603");
    expect(result.index[1]!.rosterMember).toBe(false);
  });

  it("files hold full newest-first history, series, positions and measured", () => {
    const pelosi = result.files.find((f) => f.memberId === "P000197")!.file;
    expect(parsePortfolioFile(JSON.parse(JSON.stringify(pelosi)))).toBeTruthy();
    expect(pelosi.trades.map((t) => t.transactionDate)).toEqual(["2026-05-02", "2026-03-10"]);
    expect(pelosi.series.map((p) => p.date)).toEqual(["2026-03-10", "2026-05-02"]);
    expect(pelosi.positions).toHaveLength(1); // AAPL; the muni has no ticker
    expect(pelosi.positions[0]!.security).toEqual({ ticker: "AAPL", kind: "other" });
    expect(pelosi.measured).toEqual(measured);

    const greene = result.files.find((f) => f.memberId === "G000603")!.file;
    expect(greene.measured).toBeNull();
    expect(greene.positions[0]!.security).toEqual({ ticker: "IBIT", kind: "spot-etf" });
  });

  it("counts the ticker-unresolvable muni trade as a reject, never guessed", () => {
    expect(result.positionCount).toBe(2);
    expect(result.rejects).toHaveLength(1);
    expect(result.rejects[0]!.reason).toContain("no resolvable ticker");
  });

  it("skips (with a warning) trades whose member is missing from members.json", () => {
    const orphan = buildPortfolios({
      members: MEMBERS,
      trades: [trade({ memberId: "Z000999" })],
      now: "2026-07-28",
    });
    expect(orphan.index).toEqual([]);
    expect(orphan.files).toEqual([]);
    expect(orphan.warnings.some((w) => w.includes("Z000999"))).toBe(true);
  });
});
