import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Expectations, Holding, Member, Security } from "@clarity-btc/shared";
import { parseHoldings, parseMembers, parseUniverseConfig } from "@clarity-btc/shared";
import { loadExpectations, validateHoldings } from "../../src/holdings/index.js";

import expectationsRaw from "../../../../config/expectations.json";
import universeRaw from "../../../../config/universe.json";
import holdingsRaw from "../../../../data/holdings.json";
import membersRaw from "../../../../data/members.json";

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

const UNIVERSE: Security[] = [
  { ticker: "BTC", name: "Bitcoin (direct holding)", tier: 1, kind: "direct" },
  { ticker: "BITB", name: "Bitwise Bitcoin ETF", tier: 1, kind: "spot-etf" },
  { ticker: "IBIT", name: "iShares Bitcoin Trust ETF", tier: 1, kind: "spot-etf" },
  { ticker: "COIN", name: "Coinbase Global, Inc.", tier: 2, kind: "exchange" },
];

const MEMBERS: Member[] = [
  { bioguideId: "M001243", name: "Dave McCormick", party: "R", chamber: "senate", state: "PA", active: true },
  { bioguideId: "G000603", name: "Brandon Gill", party: "R", chamber: "house", state: "TX", district: "TX-26", active: true },
  { bioguideId: "L000571", name: "Cynthia Lummis", party: "R", chamber: "senate", state: "WY", active: true },
  { bioguideId: "G000596", name: "Marjorie Taylor Greene", party: "R", chamber: "house", state: "GA", district: "GA-14", active: false },
  { bioguideId: "R000610", name: "Guy Reschenthaler", party: "R", chamber: "house", state: "PA", district: "PA-14", active: true },
];

function holding(overrides: Partial<Holding> = {}): Holding {
  return {
    memberId: "M001243",
    security: { ticker: "BITB", kind: "spot-etf" },
    owner: "self",
    range: { lo: 1000001, hi: 1600000 },
    status: "holds",
    asOf: "2025-12-29",
    extraction: "efd-html",
    verification: "unverified",
    sources: [
      { kind: "filing", url: "https://efdsearch.senate.gov/search/view/ptr/sample/" },
    ],
    ...overrides,
  };
}

/** A world that satisfies every contested pin from config/expectations.json. */
function pinSatisfyingHoldings(): Holding[] {
  return [
    holding(), // McCormick BITB (not direct BTC)
    holding({
      memberId: "G000603",
      security: { ticker: "BTC", kind: "direct" },
      range: { lo: 1150000, hi: 2600000 },
      asOf: "2025-12-31",
    }),
    holding({
      memberId: "L000571",
      security: { ticker: "BTC", kind: "direct" },
      owner: "self",
      range: { lo: 50001, hi: 100000 },
    }),
  ];
}

function expectations(overrides: Partial<Expectations> = {}): Expectations {
  return {
    holderBound: { min: 1, max: 5 },
    contested: (expectationsRaw as Expectations).contested,
    ...overrides,
  };
}

function validate(holdings: Holding[], exp: Expectations, members: Member[] = MEMBERS) {
  return validateHoldings({ holdings, expectations: exp, universe: UNIVERSE, members });
}

// ---------------------------------------------------------------------------
// Holder-count bound (taken from config, never hardcoded)
// ---------------------------------------------------------------------------

describe("validateHoldings - holder bound", () => {
  it("passes when the Tier-1 holder count sits inside the configured bound", () => {
    const report = validate(pinSatisfyingHoldings(), expectations());
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tier1HolderCount).toBe(3);
    expect(report.tier1Holders).toEqual(["G000603", "L000571", "M001243"]);
  });

  it("fails when the count falls below the configured minimum", () => {
    const report = validate(
      pinSatisfyingHoldings(),
      expectations({ holderBound: { min: 15, max: 25 } }),
    );
    expect(report.ok).toBe(false);
    const failure = report.failures.find((f) => f.code === "holder-count");
    expect(failure?.message).toContain("below the expected minimum 15");
  });

  it("fails when the count exceeds the configured maximum", () => {
    const report = validate(
      pinSatisfyingHoldings(),
      expectations({ holderBound: { min: 1, max: 2 } }),
    );
    expect(report.ok).toBe(false);
    const failure = report.failures.find((f) => f.code === "holder-count");
    expect(failure?.message).toContain("above the expected maximum 2");
  });

  it("excludes sold rows, Tier-2-only members, and inactive members", () => {
    const rows = [
      ...pinSatisfyingHoldings(),
      // Sold out - not a holder.
      holding({
        memberId: "R000610",
        security: { ticker: "BTC", kind: "direct" },
        status: "sold",
        range: { lo: 1001, hi: 15000 },
      }),
      // Tier-2 proxy only - not a Tier-1 holder.
      holding({
        memberId: "R000610",
        security: { ticker: "COIN", kind: "exchange" },
        range: { lo: 1001, hi: 15000 },
      }),
      // Historical row of a resigned member - excluded via active=false.
      holding({
        memberId: "G000596",
        security: { ticker: "IBIT", kind: "spot-etf" },
        range: { lo: 1001, hi: 15000 },
      }),
    ];
    const report = validate(rows, expectations());
    expect(report.tier1HolderCount).toBe(3);
    expect(report.tier1Holders).not.toContain("G000596");
    expect(report.tier1Holders).not.toContain("R000610");
  });
});

// ---------------------------------------------------------------------------
// Contested pins
// ---------------------------------------------------------------------------

describe("validateHoldings - contested pins", () => {
  it("fails the McCormick pin when the instrument renders as direct BTC", () => {
    const rows = [
      ...pinSatisfyingHoldings(),
      holding({
        memberId: "M001243",
        security: { ticker: "BTC", kind: "direct" },
      }),
    ];
    const report = validate(rows, expectations());
    const failure = report.failures.find((f) => f.pinId === "mccormick-instrument");
    expect(failure?.code).toBe("contested-pin");
    expect(failure?.message).toContain("forbidden security BTC:direct");
  });

  it("fails the McCormick pin when the expected BITB holding is missing", () => {
    const rows = pinSatisfyingHoldings().filter((h) => h.memberId !== "M001243");
    const report = validate(rows, expectations());
    const failure = report.failures.find((f) => f.pinId === "mccormick-instrument");
    expect(failure?.message).toContain("expected a live holding of BITB:spot-etf");
  });

  it("fails the Gill pin when the derived range does not overlap the pinned bounds", () => {
    const rows = pinSatisfyingHoldings().map((h) =>
      h.memberId === "G000603" ? { ...h, range: { lo: 15001, hi: 50000 } } : h,
    );
    const report = validate(rows, expectations());
    const failure = report.failures.find((f) => f.pinId === "gill-direct-btc-range");
    expect(failure?.message).toContain("does not overlap");
  });

  it("passes the Gill pin when the range merely overlaps the pinned bounds", () => {
    const rows = pinSatisfyingHoldings().map((h) =>
      h.memberId === "G000603" ? { ...h, range: { lo: 2000000, hi: 3100000 } } : h,
    );
    const report = validate(rows, expectations());
    expect(report.failures.filter((f) => f.pinId === "gill-direct-btc-range")).toEqual([]);
  });

  it("fails the Lummis pin when the filing-evidenced 'self' owner is lost", () => {
    // Her only BTC filing (2021 PTR) reports owner "Self"; a derived owner of
    // e.g. "trust" would be an invention with no filing behind it.
    const rows = pinSatisfyingHoldings().map((h) =>
      h.memberId === "L000571" ? { ...h, owner: "trust" as const } : h,
    );
    const report = validate(rows, expectations());
    const failure = report.failures.find((f) => f.pinId === "lummis-blind-trust");
    expect(failure?.message).toContain('pinned as "self"');
  });

  it("fails the MTG pin when the roster still marks her active", () => {
    const members = MEMBERS.map((m) =>
      m.bioguideId === "G000596" ? { ...m, active: true } : m,
    );
    const report = validate(pinSatisfyingHoldings(), expectations(), members);
    const failure = report.failures.find((f) => f.pinId === "mtg-absent");
    expect(failure?.message).toContain("marks the member active");
  });

  it("passes the MTG pin when she is inactive, even with historical rows", () => {
    const rows = [
      ...pinSatisfyingHoldings(),
      holding({
        memberId: "G000596",
        security: { ticker: "IBIT", kind: "spot-etf" },
        range: { lo: 1001, hi: 15000 },
      }),
    ];
    const report = validate(rows, expectations());
    expect(report.failures.filter((f) => f.pinId === "mtg-absent")).toEqual([]);
  });

  it("ignores sold rows when checking forbidden securities", () => {
    const rows = [
      ...pinSatisfyingHoldings(),
      holding({
        memberId: "M001243",
        security: { ticker: "BTC", kind: "direct" },
        status: "sold",
      }),
    ];
    const report = validate(rows, expectations());
    expect(report.failures.filter((f) => f.pinId === "mccormick-instrument")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Against the real repo config + fixtures
// ---------------------------------------------------------------------------

describe("validateHoldings - real config and fixtures", () => {
  const realExpectations = expectationsRaw as Expectations;
  const realUniverse = parseUniverseConfig(universeRaw);
  const realHoldings = parseHoldings(holdingsRaw);
  const realMembers = parseMembers(membersRaw);

  it("loadExpectations reads and validates config/expectations.json", async () => {
    const path = fileURLToPath(
      new URL("../../../../config/expectations.json", import.meta.url),
    );
    const loaded = await loadExpectations(path);
    expect(loaded.holderBound).toEqual({ min: 9, max: 25 });
    expect(loaded.contested.map((p) => p.id)).toEqual([
      "mccormick-instrument",
      "gill-direct-btc-range",
      "lummis-blind-trust",
      "mtg-absent",
    ]);
  });

  it("satisfies every contested pin on the fixture world", () => {
    const report = validateHoldings({
      holdings: realHoldings,
      expectations: realExpectations,
      universe: realUniverse,
      members: realMembers,
    });
    expect(report.failures.filter((f) => f.code === "contested-pin")).toEqual([]);
  });

  it("passes the recalibrated holder bound on the fixture world", () => {
    // The fixture world carries 11 Tier-1 holders (it hand-writes rows for
    // holders the live pipeline cannot see yet - Begich, Khanna, B. Moore,
    // Sheehy); the recalibrated 9-25 bound from config must accept it.
    const report = validateHoldings({
      holdings: realHoldings,
      expectations: realExpectations,
      universe: realUniverse,
      members: realMembers,
    });
    expect(report.tier1HolderCount).toBeGreaterThanOrEqual(9);
    expect(report.tier1HolderCount).toBeLessThanOrEqual(25);
    expect(report.failures.filter((f) => f.code === "holder-count")).toEqual([]);
  });
});
