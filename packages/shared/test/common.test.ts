/**
 * v1.2 common-holdings contract (build ticket 17): round-trip of
 * data/common.json rows through the shared parser, plus the invariants the
 * schema itself enforces (>= 2 owners, party split sums to ownersCount,
 * ownersCount counts exactly the non-sold owners, buyDates capped at 10).
 */
import { describe, expect, it } from "vitest";
import { parseCommonHoldings, type CommonHolding } from "../src/index.js";

const owner = {
  memberId: "P000197",
  name: "Nancy Pelosi",
  party: "D",
  chamber: "house",
  state: "CA",
  active: true,
  buyDates: ["2026-06-20", "2026-05-02"],
  latestRange: { lo: 500001, hi: 1000000 },
  status: "holds",
} as const;

const soldOwner = {
  memberId: "G000596",
  name: "Marjorie Taylor Greene",
  party: "R",
  chamber: "house",
  state: "GA",
  active: false,
  buyDates: ["2025-11-03"],
  latestRange: { lo: 1001, hi: 15000 },
  status: "sold",
} as const;

const lummis = {
  memberId: "L000571",
  name: "Cynthia Lummis",
  party: "R",
  chamber: "senate",
  state: "WY",
  active: true,
  buyDates: [],
  latestRange: { lo: 100001, hi: 250000 },
  status: "stale",
} as const;

const row = {
  security: { ticker: "IBIT", kind: "spot-etf" },
  name: "iShares Bitcoin Trust ETF",
  ownersCount: 2,
  partySplit: { R: 1, D: 1, I: 0 },
  latestBuyDate: "2026-06-20",
  owners: [owner, lummis, soldOwner],
};

describe("CommonHolding contract", () => {
  it("round-trips through serialization and the shared parser", () => {
    const parsed: CommonHolding[] = parseCommonHoldings(JSON.parse(JSON.stringify([row])));
    expect(parsed).toEqual([row]);
    // Reserialize-and-reparse is stable (what writeOutputsAtomically enforces).
    expect(parseCommonHoldings(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("accepts a non-universe security ('other' kind, no resolved name) and a null latest buy", () => {
    const other = {
      ...row,
      security: { ticker: "AAPL", kind: "other" },
      latestBuyDate: null,
      owners: [{ ...owner, buyDates: [] }, lummis],
    };
    delete (other as { name?: string }).name;
    const parsed = parseCommonHoldings([other])[0]!;
    expect(parsed.name).toBeUndefined();
    expect(parsed.latestBuyDate).toBeNull();
  });

  it("rejects rows with fewer than 2 owners - common means shared", () => {
    expect(() => parseCommonHoldings([{ ...row, ownersCount: 1, owners: [owner] }])).toThrow();
  });

  it("rejects a party split that does not sum to ownersCount", () => {
    expect(() =>
      parseCommonHoldings([{ ...row, partySplit: { R: 2, D: 1, I: 0 } }]),
    ).toThrow(/partySplit/);
  });

  it("rejects an ownersCount that disagrees with the non-sold owners", () => {
    // Sold owners are listed but never counted.
    expect(() =>
      parseCommonHoldings([
        { ...row, ownersCount: 3, partySplit: { R: 2, D: 1, I: 0 } },
      ]),
    ).toThrow(/non-sold/);
  });

  it("caps buyDates at 10 and requires ISO dates", () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`);
    expect(() =>
      parseCommonHoldings([{ ...row, owners: [{ ...owner, buyDates: tooMany }, lummis] }]),
    ).toThrow();
    expect(() =>
      parseCommonHoldings([{ ...row, owners: [{ ...owner, buyDates: ["06/20/2026"] }, lummis] }]),
    ).toThrow();
  });
});
