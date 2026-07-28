/** Formatting helpers: currency ranges, dates, signed percentages. */
import type { ValueRange } from "@clarity-btc/shared";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Typographic minus (U+2212) — a hyphen reads as a dash in "-23.2%". */
export const MINUS = "−";
/** En dash for ranges and tallies. */
export const NDASH = "–";

/** "$1.6M", "$50K", "$800". Disclosure bands, so coarse rounding is honest. */
export function fmtUsd(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    const rounded = m >= 10 ? Math.round(m).toString() : (Math.round(m * 10) / 10).toString();
    return `$${rounded}M`;
  }
  if (n >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

/** "$15K–$50K" */
export function fmtRange(r: ValueRange): string {
  return `${fmtUsd(r.lo)}${NDASH}${fmtUsd(r.hi)}`;
}

function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** "2025-07-17" → "Jul 17, 2025" (no Date object — avoids timezone off-by-one). */
export function fmtDate(iso: string): string {
  const p = parseIso(iso);
  if (!p) return iso;
  return `${MONTHS[p.m - 1] ?? "?"} ${p.d}, ${p.y}`;
}

/** "2025-04-24" → "Apr 2025" */
export function fmtMonthYear(iso: string): string {
  const p = parseIso(iso);
  if (!p) return iso;
  return `${MONTHS[p.m - 1] ?? "?"} ${p.y}`;
}

/** "+62.5%", "−23.2%", "0.0%" — sign always explicit for nonzero. */
export function fmtSignedPct(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? MINUS : "";
  return `${sign}${Math.abs(v).toFixed(1)}%`;
}

/** "+41.5 pp vs SPY" style excess formatting. */
export function fmtSignedPp(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? MINUS : "";
  return `${sign}${Math.abs(v).toFixed(1)} pp`;
}

/** "294–134" */
export function fmtTally(yea: number, nay: number): string {
  return `${yea}${NDASH}${nay}`;
}
