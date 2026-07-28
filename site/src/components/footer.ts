/**
 * Methodology footer (approved copy from the design ticket): range semantics,
 * 45-day filing lag, spouse attribution, "disclosed ≠ currently holds",
 * official-filing links, and the as-of date from meta.json.
 */
import type { Meta } from "@clarity-btc/shared";
import { el } from "../dom";
import { fmtDate } from "../format";

export function renderFooter(meta: Meta): HTMLElement {
  const foot = el("footer", { class: "foot" });
  foot.appendChild(el("p", { class: "eyebrow" }, "Methodology"));
  foot.appendChild(
    el(
      "p",
      {},
      "Holdings come from STOCK Act filings (Senate eFD and House Clerk records), which report value ranges, not exact amounts, and may be filed up to 45 days after a trade. Rows are cross-checked against news coverage; unverified rows are flagged. Spouse and dependent holdings are attributed to the member with a note. “Disclosed a trade” is not proof of a current position.",
    ),
  );
  foot.appendChild(
    el(
      "p",
      {},
      "Measured trader returns use range midpoints against daily closes, benchmarked to SPY; options legs that cannot be priced from equity closes are excluded and noted. Claims from X are quoted and attributed, never asserted.",
    ),
  );
  const stamp = el("p", {});
  stamp.append(
    `Data as of ${fmtDate(meta.asOf.holdings)} (bill status ${fmtDate(meta.asOf.bill)}, trades ${fmtDate(meta.asOf.trades)}) · generated ${meta.generatedAt} · Every row links to its official filing.`,
  );
  foot.appendChild(stamp);
  return foot;
}
