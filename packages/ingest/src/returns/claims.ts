/**
 * Measured-vs-claims comparison (integration ticket 11).
 *
 * X claims are quoted strings; some state a numeric return ("+52% gain").
 * Where a claim carries a number AND we measured this trader, we compare -
 * but only at sign level: the claim's window (usually a calendar year) is not
 * the measured since-trade window, so magnitudes are not comparable and a
 * stricter test would manufacture false "busted" verdicts. A claimed gain
 * with a measured loss (or flat) is not supported by the filings.
 *
 * Returns undefined when nothing is computable - volume/frequency claims
 * ("most active trader") carry no measurable return, and unmeasured traders
 * cannot contradict anything.
 */
import type { Trader } from "@clarity-btc/shared";

type Claim = Trader["claims"][number];

/** Words that mark a quote as being about investment performance. */
const PERFORMANCE_RE = /\b(return|gain|profit|performance|loss|underperform|beat|up|down)\b/i;

/** Words that flip an unsigned percentage into a claimed loss. */
const NEGATIVE_RE = /\b(loss|losses|lost|down|underperformed?)\b/i;

const PERCENT_RE = /([+-]?)(\d+(?:\.\d+)?)\s*%/;

/**
 * Extract the claimed return (signed percent) from one quote, or null when
 * the quote states no performance number.
 */
export function extractClaimedReturnPct(quote: string): number | null {
  if (!PERFORMANCE_RE.test(quote)) return null;
  const m = PERCENT_RE.exec(quote);
  if (m === null) return null;
  const value = Number(m[2]);
  if (!Number.isFinite(value)) return null;
  const negative = m[1] === "-" || NEGATIVE_RE.test(quote);
  return negative ? -value : value;
}

/**
 * Sign-level support check: every numeric return claim must agree in sign
 * with the measured return. Undefined when not computable (no numeric claims,
 * or nothing measured).
 */
export function claimsSupportedByMeasured(
  claims: readonly Claim[],
  measuredReturn: number | null,
): boolean | undefined {
  const claimed = claims
    .map((c) => extractClaimedReturnPct(c.quote))
    .filter((v): v is number => v !== null && v !== 0);
  if (claimed.length === 0 || measuredReturn === null) return undefined;
  return claimed.every((pct) => (pct > 0 ? measuredReturn > 0 : measuredReturn < 0));
}
