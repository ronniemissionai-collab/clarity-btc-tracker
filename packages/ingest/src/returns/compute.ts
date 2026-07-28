/**
 * Pure return math for the portfolio tracker (methodology ticket 11):
 * range-midpoint cost basis per trade, simple since-trade returns, and
 * midpoint-weighted aggregation with SPY excess. Everything here is an
 * ESTIMATE - STOCK Act filings disclose value bands, never exact amounts.
 */
import type { ValueRange } from "@clarity-btc/shared";

/** Midpoint of a disclosed value band - the convention UW/Quiver also use. */
export function rangeMidpoint(range: ValueRange): number {
  return (range.lo + range.hi) / 2;
}

/** Simple percent return from an entry close to a current close. */
export function simpleReturnPct(entryClose: number, currentClose: number): number {
  if (entryClose <= 0) {
    throw new RangeError(`entry close must be positive, got ${entryClose}`);
  }
  return (currentClose / entryClose - 1) * 100;
}

/** Round to one decimal - band midpoints don't support more precision. */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** One scored buy: the sparkline/point payload behind a member's aggregate. */
export interface TradeReturnPoint {
  /** Transaction (trade) date, ISO. */
  date: string;
  /** Resolved ticker; null when kadoa scored a row we couldn't name. */
  ticker: string | null;
  /** Estimated cost basis: disclosed-range midpoint, USD. */
  midpoint: number;
  /** Estimated percent return since the trade date. */
  ret: number;
  /** Excess vs SPY over the same window, percentage points; null if SPY was unavailable. */
  excess: number | null;
  /** Which source priced the row. */
  source: "kadoa" | "yahoo";
}

export interface AggregateReturn {
  /** Midpoint-weighted mean since-trade return, percent. */
  return: number;
  /** Midpoint-weighted mean excess vs SPY, pp; null when no point had a benchmark. */
  excess: number | null;
  /** Number of scored buys. */
  scored: number;
}

/**
 * Aggregate a member's scored buys, weighting each trade by its disclosed
 * range midpoint (bigger disclosed positions move the estimate more).
 */
export function aggregateMidpointWeighted(points: TradeReturnPoint[]): AggregateReturn | null {
  if (points.length === 0) return null;
  let weight = 0;
  let retSum = 0;
  let excessWeight = 0;
  let excessSum = 0;
  for (const p of points) {
    const w = p.midpoint;
    weight += w;
    retSum += w * p.ret;
    if (p.excess !== null) {
      excessWeight += w;
      excessSum += w * p.excess;
    }
  }
  if (weight <= 0) return null;
  return {
    return: retSum / weight,
    excess: excessWeight > 0 ? excessSum / excessWeight : null,
    scored: points.length,
  };
}

/**
 * Options/derivative positions (the Pelosi LEAPS case) cannot be marked to
 * market from equity closes - they are excluded and counted, never guessed.
 * Word-boundary match so "callable"/"putnam" don't trip it.
 */
const OPTIONS_TEXT = /\b(call|put|option|options|leaps?|warrants?)\b/i;

export function isOptionsPosition(assetRaw: string, assetType?: string | null): boolean {
  if (assetType != null) {
    const t = assetType.trim().toUpperCase();
    if (t === "OP" || t.startsWith("OPT")) return true;
  }
  return OPTIONS_TEXT.test(assetRaw);
}

/**
 * Last-resort ticker recovery from filing text like
 * "Apple Inc. - Common Stock (AAPL)". Used only when neither kadoa nor the
 * security universe resolved the row.
 */
export function extractTicker(assetRaw: string): string | null {
  const m = /\(([A-Z][A-Z0-9.-]{0,9})\)/.exec(assetRaw);
  return m?.[1] ?? null;
}
