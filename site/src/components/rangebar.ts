/**
 * Disclosed-range bar: positions a lo→hi band on a shared 0→max scale so the
 * Tier 1 columns are visually comparable.
 */
import type { ValueRange } from "@clarity-btc/shared";
import { el } from "../dom";
import { fmtRange } from "../format";

export interface RangeBarGeometry {
  leftPct: number;
  widthPct: number;
}

/** Bands narrower than this render at minimum width so they stay visible. */
export const MIN_WIDTH_PCT = 2;

/**
 * Pure geometry: percentages for the band's offset and width on a 0→max scale.
 * Degenerate inputs (max <= 0, hi <= 0) collapse to an empty bar; the band is
 * clamped so leftPct + widthPct never exceeds 100.
 */
export function rangeBarGeometry(lo: number, hi: number, max: number): RangeBarGeometry {
  if (!(max > 0) || hi <= 0) return { leftPct: 0, widthPct: 0 };
  const clampedLo = Math.min(Math.max(lo, 0), max);
  const clampedHi = Math.min(Math.max(hi, clampedLo), max);
  const widthPct = Math.min(100, Math.max(MIN_WIDTH_PCT, ((clampedHi - clampedLo) / max) * 100));
  const leftPct = Math.min((clampedLo / max) * 100, 100 - widthPct);
  return { leftPct, widthPct };
}

export function renderRangeBar(range: ValueRange, max: number): HTMLElement {
  const { leftPct, widthPct } = rangeBarGeometry(range.lo, range.hi, max);
  const bar = el("div", {
    class: "rangebar",
    role: "img",
    "aria-label": `Disclosed range ${fmtRange(range)}`,
    title: fmtRange(range),
  });
  const band = el("span", { class: "rangebar-band" });
  band.style.left = `${leftPct.toFixed(1)}%`;
  band.style.width = `${widthPct.toFixed(1)}%`;
  bar.appendChild(band);
  return bar;
}
