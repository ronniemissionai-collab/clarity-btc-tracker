/**
 * v1.2 common-holdings aggregation (build ticket 17): grouping by security
 * across members, sold owners excluded from the count but listed, party
 * split, buy-date ordering/capping, the >= 2-owner filter, name resolution
 * and the ownersCount-desc-then-ticker sort.
 */
import { describe, expect, it } from "vitest";
import type { Member, PortfolioPosition, Security } from "@clarity-btc/shared";
import { parseCommonHoldings, securityKey } from "@clarity-btc/shared";
import type { AllTickerTrade } from "../../src/holdings/index.js";
import { buildCommonHoldings, buildPortfolios, COMMON_BUY_DATES_CAP } from "../../src/portfolio/index.js";

const HOUSE_DOC = "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20030001.pdf";

const PELOSI: Member = {
  bioguideId: "P000197",
  name: "Nancy Pelosi",
  party: "D",
  chamber: "house",
  state: "CA",
  active: true,
};
const GREENE: Member = {
  bioguideId: "G000603",
  name: "Marjorie Taylor Greene",
  party: "R",
  chamber: "house",
  state: "GA",
  active: false,
};
const LUMMIS: Member = {
  bioguideId: "L000571",
  name: "Cynthia Lummis",
  party: "R",
  chamber: "senate",
  state: "WY",
  active: true,
};
const MEMBERS = [PELOSI, GREENE, LUMMIS];

const IBIT = { ticker: "IBIT", kind: "spot-etf" } as const;
const AAPL = { ticker: "AAPL", kind: "other" } as const;

const UNIVERSE: Security[] = [
  { ticker: "IBIT", name: "iShares Bitcoin Trust ETF", tier: 1, kind: "spot-etf" },
];

function position(overrides: Partial<PortfolioPosition> = {}): PortfolioPosition {
  return {
    memberId: "P000197",
    security: IBIT,
    owner: "self",
    range: { lo: 1001, hi: 15000 },
    status: "holds",
    asOf: "2026-06-20",
    extraction: "pdf-text",
    verification: "unverified",
    sources: [{ kind: "filing", url: HOUSE_DOC }],
    ...overrides,
  };
}

function buy(overrides: Partial<AllTickerTrade> = {}): AllTickerTrade {
  return {
    memberId: "P000197",
    assetRaw: "iShares Bitcoin Trust ETF (IBIT) [ST]",
    security: IBIT,
    side: "buy",
    owner: "self",
    range: { lo: 1001, hi: 15000 },
    transactionDate: "2026-06-20",
    filedDate: "2026-07-01",
    docUrl: HOUSE_DOC,
    late: false,
    ...overrides,
  };
}

describe("buildCommonHoldings", () => {
  it("groups by security key across members and resolves universe names", () => {
    const rows = buildCommonHoldings({
      members: MEMBERS,
      positions: [
        position(),
        position({ memberId: "G000603", owner: "spouse", range: { lo: 15001, hi: 50000 } }),
        // Same ticker, different kind: a DIFFERENT security (never merged).
        position({ memberId: "L000571", security: { ticker: "IBIT", kind: "other" } }),
      ],
      trades: [buy(), buy({ memberId: "G000603", owner: "spouse", transactionDate: "2026-07-01" })],
      securities: UNIVERSE,
    });
    expect(rows).toHaveLength(1); // IBIT:other has one owner - filtered out
    const row = rows[0]!;
    expect(row.security).toEqual(IBIT);
    expect(row.name).toBe("iShares Bitcoin Trust ETF");
    expect(row.ownersCount).toBe(2);
    expect(row.latestBuyDate).toBe("2026-07-01");
    // Owners ordered most-recent-buy first; each carries directory metadata.
    expect(row.owners.map((o) => o.memberId)).toEqual(["G000603", "P000197"]);
    expect(row.owners[0]).toEqual({
      memberId: "G000603",
      name: "Marjorie Taylor Greene",
      party: "R",
      chamber: "house",
      state: "GA",
      active: false,
      buyDates: ["2026-07-01"],
      latestRange: { lo: 15001, hi: 50000 },
      status: "holds",
    });
    // The emitted rows satisfy the shared contract as serialized.
    expect(parseCommonHoldings(JSON.parse(JSON.stringify(rows)))).toEqual(rows);
  });

  it("omits the name for securities outside the universe - never guessed", () => {
    const rows = buildCommonHoldings({
      members: MEMBERS,
      positions: [
        position({ security: AAPL }),
        position({ memberId: "L000571", security: AAPL }),
      ],
      trades: [],
      securities: UNIVERSE,
    });
    expect(rows[0]!.name).toBeUndefined();
    expect(rows[0]!.latestBuyDate).toBeNull(); // annual-only, no disclosed buys
  });

  it("excludes SOLD members from ownersCount and the party split but lists them", () => {
    const rows = buildCommonHoldings({
      members: MEMBERS,
      positions: [
        position(), // Pelosi holds (D)
        position({ memberId: "L000571" }), // Lummis holds (R)
        position({ memberId: "G000603", status: "sold", asOf: "2026-03-01" }), // exited
      ],
      trades: [buy({ memberId: "G000603", transactionDate: "2026-01-15" })],
    });
    const row = rows[0]!;
    expect(row.ownersCount).toBe(2);
    expect(row.partySplit).toEqual({ R: 1, D: 1, I: 0 });
    // The exited member still appears, flagged sold, sorted after the holders.
    expect(row.owners).toHaveLength(3);
    expect(row.owners[2]!.memberId).toBe("G000603");
    expect(row.owners[2]!.status).toBe("sold");
    expect(row.owners[2]!.buyDates).toEqual(["2026-01-15"]);
  });

  it("drops securities with fewer than 2 CURRENT owners (sold rows don't count)", () => {
    const rows = buildCommonHoldings({
      members: MEMBERS,
      positions: [
        position(), // one current owner
        position({ memberId: "G000603", status: "sold" }), // one exited owner
      ],
      trades: [],
    });
    expect(rows).toEqual([]);
  });

  it("counts each member once across owner attributions and sums their ranges", () => {
    const rows = buildCommonHoldings({
      members: MEMBERS,
      positions: [
        position({ owner: "self", range: { lo: 1001, hi: 15000 } }),
        position({ owner: "spouse", range: { lo: 15001, hi: 50000 }, status: "stale" }),
        position({ owner: "trust", range: { lo: 500, hi: 600 }, status: "sold" }),
        position({ memberId: "L000571" }),
      ],
      trades: [],
    });
    const row = rows[0]!;
    expect(row.ownersCount).toBe(2); // Pelosi once + Lummis once
    const pelosi = row.owners.find((o) => o.memberId === "P000197")!;
    // Current (non-sold) attributions aggregate band-wise; the sold trust
    // position is excluded from the range and does not flip the status.
    expect(pelosi.latestRange).toEqual({ lo: 16002, hi: 65000 });
    expect(pelosi.status).toBe("holds");
  });

  it("marks a member whose only current positions are stale as stale", () => {
    const rows = buildCommonHoldings({
      members: MEMBERS,
      positions: [
        position({ status: "stale", asOf: "2025-01-02" }),
        position({ memberId: "L000571" }),
      ],
      trades: [],
    });
    const pelosi = rows[0]!.owners.find((o) => o.memberId === "P000197")!;
    expect(pelosi.status).toBe("stale");
  });

  it("caps buyDates at 10, newest first, and only counts BUY trades", () => {
    const buys = Array.from({ length: 14 }, (_, i) =>
      buy({ transactionDate: `2026-01-${String(i + 1).padStart(2, "0")}` }),
    );
    const rows = buildCommonHoldings({
      members: MEMBERS,
      positions: [position(), position({ memberId: "L000571" })],
      trades: [
        ...buys,
        buy({ side: "sell", transactionDate: "2026-02-01", note: "partial sale" }),
        buy({ memberId: "L000571", transactionDate: "2026-01-20" }),
      ],
    });
    const pelosi = rows[0]!.owners.find((o) => o.memberId === "P000197")!;
    expect(pelosi.buyDates).toHaveLength(COMMON_BUY_DATES_CAP);
    expect(pelosi.buyDates[0]).toBe("2026-01-14"); // newest kept, sell ignored
    expect(pelosi.buyDates.at(-1)).toBe("2026-01-05"); // oldest four dropped
    expect(rows[0]!.latestBuyDate).toBe("2026-01-20"); // across all owners
  });

  it("sorts ownersCount desc then ticker, and skips members without a roster row", () => {
    const rows = buildCommonHoldings({
      members: MEMBERS,
      positions: [
        // ZZZ: 3 owners; AAPL: 2 owners; MMM: 2 owners.
        position({ security: { ticker: "ZZZ", kind: "other" } }),
        position({ memberId: "G000603", security: { ticker: "ZZZ", kind: "other" } }),
        position({ memberId: "L000571", security: { ticker: "ZZZ", kind: "other" } }),
        position({ security: AAPL }),
        position({ memberId: "L000571", security: AAPL }),
        position({ security: { ticker: "MMM", kind: "other" } }),
        position({ memberId: "L000571", security: { ticker: "MMM", kind: "other" } }),
        // An unknown member never ships (no members.json row - no portfolio).
        position({ memberId: "Z000999", security: AAPL }),
      ],
      trades: [],
    });
    expect(rows.map((r) => r.security.ticker)).toEqual(["ZZZ", "AAPL", "MMM"]);
    expect(rows[1]!.owners.some((o) => o.memberId === "Z000999")).toBe(false);
  });
});

describe("buildPortfolios.common (same derivation, second view)", () => {
  it("aggregates the common holdings from the portfolio build's own positions", () => {
    const result = buildPortfolios({
      members: MEMBERS,
      trades: [
        buy(),
        buy({ memberId: "L000571", owner: "self", transactionDate: "2026-05-11" }),
        buy({
          memberId: "G000603",
          assetRaw: "Apple Inc. - Common Stock (AAPL) [ST]",
          security: null, // resolved to AAPL:other by resolveAllTickerTrades
          transactionDate: "2026-04-01",
        }),
      ],
      universe: UNIVERSE,
      now: "2026-07-28",
    });
    expect(result.common).toHaveLength(1);
    const row = result.common[0]!;
    expect(securityKey(row.security)).toBe("IBIT:spot-etf");
    expect(row.name).toBe("iShares Bitcoin Trust ETF");
    expect(row.ownersCount).toBe(2);
    expect(row.partySplit).toEqual({ R: 1, D: 1, I: 0 });
    // The owners' positions are the very ones the member files ship.
    const files = new Map(result.files.map((f) => [f.memberId, f.file]));
    for (const owner of row.owners) {
      const file = files.get(owner.memberId)!;
      expect(file.positions.some((p) => securityKey(p.security) === "IBIT:spot-etf")).toBe(true);
    }
  });
});
