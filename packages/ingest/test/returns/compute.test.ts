import { describe, expect, it } from "vitest";
import {
  aggregateMidpointWeighted,
  extractTicker,
  isOptionsPosition,
  rangeMidpoint,
  round1,
  simpleReturnPct,
  type TradeReturnPoint,
} from "../../src/returns/index.js";

function point(overrides: Partial<TradeReturnPoint>): TradeReturnPoint {
  return {
    date: "2026-01-02",
    ticker: "TEST",
    midpoint: 8000.5,
    ret: 0,
    excess: null,
    source: "kadoa",
    ...overrides,
  };
}

describe("rangeMidpoint", () => {
  it("takes the middle of the disclosed band", () => {
    expect(rangeMidpoint({ lo: 1001, hi: 15000 })).toBe(8000.5);
    expect(rangeMidpoint({ lo: 50001, hi: 100000 })).toBe(75000.5);
  });

  it("is the identity on a degenerate band", () => {
    expect(rangeMidpoint({ lo: 5000, hi: 5000 })).toBe(5000);
  });
});

describe("simpleReturnPct", () => {
  it("computes percent return from entry to current close", () => {
    expect(simpleReturnPct(100, 150)).toBeCloseTo(50, 10);
    expect(simpleReturnPct(200, 150)).toBeCloseTo(-25, 10);
    expect(simpleReturnPct(100, 100)).toBe(0);
  });

  it("rejects non-positive entry closes", () => {
    expect(() => simpleReturnPct(0, 100)).toThrow(RangeError);
    expect(() => simpleReturnPct(-5, 100)).toThrow(RangeError);
  });
});

describe("aggregateMidpointWeighted", () => {
  it("returns null for no scored buys", () => {
    expect(aggregateMidpointWeighted([])).toBeNull();
  });

  it("weights each trade's return by its disclosed-range midpoint", () => {
    const agg = aggregateMidpointWeighted([
      point({ midpoint: 1000, ret: 10, excess: 2 }),
      point({ midpoint: 3000, ret: 20, excess: 6 }),
    ]);
    // (1000*10 + 3000*20) / 4000 = 17.5 - NOT the unweighted mean 15.
    expect(agg?.return).toBeCloseTo(17.5, 10);
    expect(agg?.excess).toBeCloseTo(5, 10);
    expect(agg?.scored).toBe(2);
  });

  it("computes excess only over points that have a benchmark", () => {
    const agg = aggregateMidpointWeighted([
      point({ midpoint: 1000, ret: 10, excess: null }),
      point({ midpoint: 100, ret: 30, excess: 4 }),
    ]);
    // Return weights all points; excess weights only the benchmarked one.
    expect(agg?.return).toBeCloseTo((1000 * 10 + 100 * 30) / 1100, 10);
    expect(agg?.excess).toBeCloseTo(4, 10);
  });

  it("reports null excess when no point had a benchmark", () => {
    const agg = aggregateMidpointWeighted([point({ midpoint: 500, ret: 1, excess: null })]);
    expect(agg?.excess).toBeNull();
  });
});

describe("round1", () => {
  it("rounds to one decimal", () => {
    expect(round1(-27.792965133868922)).toBe(-27.8);
    expect(round1(10.04)).toBe(10);
  });
});

describe("isOptionsPosition", () => {
  it("flags option text (the Pelosi LEAPS case)", () => {
    expect(isOptionsPosition("Alphabet Inc. - Class A Common Stock Call Options")).toBe(true);
    expect(isOptionsPosition("NVIDIA Corp Put Option, strike $100")).toBe(true);
    expect(isOptionsPosition("Broadcom Inc LEAPS Jan 2027")).toBe(true);
  });

  it("flags kadoa asset_type OP even when the text looks like plain stock", () => {
    expect(isOptionsPosition("Uber Technologies, Inc. Common Stock", "OP")).toBe(true);
  });

  it("does not trip on look-alike words or plain stock", () => {
    expect(isOptionsPosition("Bitwise Bitcoin ETF")).toBe(false);
    expect(isOptionsPosition("Callable Corporate Notes 2030", "ST")).toBe(false);
    expect(isOptionsPosition("Putnam Global Income Fund")).toBe(false);
  });
});

describe("extractTicker", () => {
  it("recovers a parenthesized ticker from filing text", () => {
    expect(extractTicker("Apple Inc. - Common Stock (AAPL)")).toBe("AAPL");
    expect(extractTicker("Berkshire Hathaway Class B (BRK.B)")).toBe("BRK.B");
  });

  it("returns null when there is nothing ticker-shaped", () => {
    expect(extractTicker("Tesla, Inc. - Common Stock")).toBeNull();
    expect(extractTicker("Family Farm LLC (private)")).toBeNull();
  });
});
