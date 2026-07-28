/**
 * Measured-vs-claims comparison (integration ticket 11): numeric return
 * claims are compared at sign level only; volume/frequency claims and
 * unmeasured traders yield "not computable" (undefined), never false.
 */
import { describe, expect, it } from "vitest";
import {
  claimsSupportedByMeasured,
  extractClaimedReturnPct,
} from "../../src/returns/claims.js";

const claim = (quote: string): { quote: string; sourceUrl: string } => ({
  quote,
  sourceUrl: "https://example.com/source",
});

describe("extractClaimedReturnPct", () => {
  it("extracts a claimed gain", () => {
    expect(extractClaimedReturnPct("2025's best market return in Congress with a +52% gain.")).toBe(52);
    expect(extractClaimedReturnPct("+37% return in 2025, third-best in Congress.")).toBe(37);
    expect(extractClaimedReturnPct("posted a 122.5% return")).toBe(122.5);
  });

  it("extracts a claimed loss from sign or wording", () => {
    expect(extractClaimedReturnPct("portfolio return of -12% last year")).toBe(-12);
    expect(extractClaimedReturnPct("down 8% on the year, an unusual loss")).toBe(-8);
  });

  it("returns null for volume/frequency claims and bare percentages", () => {
    expect(
      extractClaimedReturnPct("Most active trader in Congress; 3,482 all-time disclosed trades."),
    ).toBeNull();
    expect(extractClaimedReturnPct("sold 50% of the position")).toBeNull(); // no performance wording
    expect(extractClaimedReturnPct("best market return in Congress")).toBeNull(); // no number
  });
});

describe("claimsSupportedByMeasured", () => {
  it("is undefined when nothing is computable", () => {
    expect(claimsSupportedByMeasured([claim("most active trader, 1,000 trades")], 15)).toBeUndefined();
    expect(claimsSupportedByMeasured([claim("+52% gain")], null)).toBeUndefined();
    expect(claimsSupportedByMeasured([], 15)).toBeUndefined();
  });

  it("supports a claimed gain only when the measured return is positive", () => {
    expect(claimsSupportedByMeasured([claim("+52% gain")], 62.5)).toBe(true);
    expect(claimsSupportedByMeasured([claim("+52% gain")], 0.4)).toBe(true); // sign-level only
    expect(claimsSupportedByMeasured([claim("+52% gain")], -3.1)).toBe(false);
    expect(claimsSupportedByMeasured([claim("+52% gain")], 0)).toBe(false);
  });

  it("requires every numeric claim to agree", () => {
    expect(
      claimsSupportedByMeasured([claim("+52% gain"), claim("a 12% loss in 2024")], 10),
    ).toBe(false);
    expect(
      claimsSupportedByMeasured([claim("+52% gain"), claim("most active trader")], 10),
    ).toBe(true); // the volume claim is not measurable and does not count against
  });
});
