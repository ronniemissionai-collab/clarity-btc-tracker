/**
 * Sparkline built from real per-trade points (disclosed range midpoints over
 * transaction dates). The prototype faked these with a sine wave; here a
 * trader with fewer than two mapped trades gets an honest empty state instead.
 */
import { el } from "../dom";
import { fmtUsd } from "../format";

export interface SparkPoint {
  /** ISO date of the trade. */
  date: string;
  /** Disclosed range midpoint, USD. */
  value: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW_W = 100;
const VIEW_H = 34;
const PAD = 3;

export function renderSparkline(points: SparkPoint[], memberName: string): HTMLElement {
  if (points.length < 2) {
    return el(
      "p",
      { class: "spark-empty" },
      "No per-trade series in the mapped filings yet.",
    );
  }

  const xs = points.map((p) => Date.parse(p.date));
  const ys = points.map((p) => p.value);
  const xMin = Math.min(...xs);
  const xSpan = Math.max(...xs) - xMin || 1;
  const yMin = Math.min(...ys);
  const ySpan = Math.max(...ys) - yMin || 1;

  const coords = points.map((p, i) => {
    const x = PAD + ((Date.parse(p.date) - xMin) / xSpan) * (VIEW_W - 2 * PAD);
    const y = VIEW_H - PAD - ((ys[i] ?? yMin) - yMin) / ySpan * (VIEW_H - 2 * PAD);
    return { x, y };
  });

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  const first = points[0];
  const last = points[points.length - 1];
  svg.setAttribute(
    "aria-label",
    `${memberName}: ${points.length} disclosed trades, midpoints ${fmtUsd(yMin)} to ${fmtUsd(yMin + ySpan)}` +
      (first && last ? `, ${first.date} to ${last.date}` : ""),
  );

  const line = document.createElementNS(SVG_NS, "polyline");
  line.setAttribute("points", coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "var(--accent)");
  line.setAttribute("stroke-width", "1.6");
  svg.appendChild(line);

  const end = coords[coords.length - 1];
  if (end) {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", end.x.toFixed(1));
    dot.setAttribute("cy", end.y.toFixed(1));
    dot.setAttribute("r", "2.2");
    dot.setAttribute("fill", "var(--accent)");
    svg.appendChild(dot);
  }

  const wrap = el("div", { class: "spark-wrap" });
  wrap.appendChild(svg);
  wrap.appendChild(
    el("small", { class: "spark-caption" }, "Disclosed trade sizes over time (range midpoints)"),
  );
  return wrap;
}
