// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  MIN_WIDTH_PCT,
  rangeBarGeometry,
  renderRangeBar,
} from "../src/components/rangebar";

describe("rangeBarGeometry", () => {
  it("maps the full 0..max range to the whole track", () => {
    expect(rangeBarGeometry(0, 1000, 1000)).toEqual({ leftPct: 0, widthPct: 100 });
  });

  it("positions a band proportionally", () => {
    const g = rangeBarGeometry(250, 750, 1000);
    expect(g.leftPct).toBeCloseTo(25);
    expect(g.widthPct).toBeCloseTo(50);
  });

  it("keeps narrow disclosure bands visible at the minimum width", () => {
    const g = rangeBarGeometry(1001, 15000, 2_600_000);
    expect(g.widthPct).toBe(MIN_WIDTH_PCT);
    expect(g.leftPct).toBeCloseTo((1001 / 2_600_000) * 100, 1);
  });

  it("clamps so the band never overflows the track", () => {
    const g = rangeBarGeometry(2_599_000, 2_600_000, 2_600_000);
    expect(g.leftPct + g.widthPct).toBeLessThanOrEqual(100);
    expect(g.widthPct).toBeGreaterThanOrEqual(MIN_WIDTH_PCT);
  });

  it("clamps hi above max to the end of the track", () => {
    const g = rangeBarGeometry(500, 5000, 1000);
    expect(g.leftPct).toBeCloseTo(50);
    expect(g.widthPct).toBeCloseTo(50);
  });

  it("collapses degenerate scales instead of dividing by zero", () => {
    expect(rangeBarGeometry(0, 0, 0)).toEqual({ leftPct: 0, widthPct: 0 });
    expect(rangeBarGeometry(10, 20, 0)).toEqual({ leftPct: 0, widthPct: 0 });
    expect(rangeBarGeometry(0, 0, 1000)).toEqual({ leftPct: 0, widthPct: 0 });
  });
});

describe("renderRangeBar", () => {
  it("renders the band with the computed geometry and an accessible label", () => {
    const bar = renderRangeBar({ lo: 250, hi: 750 }, 1000);
    expect(bar.classList.contains("rangebar")).toBe(true);
    expect(bar.getAttribute("role")).toBe("img");
    expect(bar.getAttribute("aria-label")).toContain("$250–$750");
    const band = bar.querySelector<HTMLElement>(".rangebar-band");
    expect(band).not.toBeNull();
    expect(band?.style.left).toBe("25.0%");
    expect(band?.style.width).toBe("50.0%");
  });
});
