/**
 * Hero thesis (Variant C organ of the composite): headline stating the House
 * vote result and holder count — both computed from data — with a one-line
 * subhead and an "updated daily" eyebrow.
 */
import type { Meta } from "@clarity-btc/shared";
import { el } from "../dom";
import { fmtDate, fmtTally } from "../format";
import type { Model } from "../derive";
import { createThemeToggle } from "../theme";

export function renderHero(model: Model, meta: Meta): HTMLElement {
  const header = el("header", { class: "hero" });

  const topbar = el("div", { class: "topbar" });
  topbar.appendChild(
    el(
      "p",
      { class: "eyebrow" },
      `Congressional Bitcoin Ledger · updated daily · data as of ${fmtDate(meta.asOf.holdings)}`,
    ),
  );
  topbar.appendChild(createThemeToggle());
  header.appendChild(topbar);

  const h1 = el("h1", {});
  if (model.housePassage) {
    h1.append(
      "Congress voted ",
      el("span", { class: "big" }, fmtTally(model.housePassage.yea, model.housePassage.nay)),
      " on crypto rules. ",
    );
  } else {
    h1.append("Congress is rewriting crypto rules. ");
  }
  h1.append(
    el(
      "span",
      { class: "big" },
      `${model.holderCount} member${model.holderCount === 1 ? "" : "s"}`,
    ),
    " hold Bitcoin.",
  );
  header.appendChild(h1);

  const shortTitle = model.bill.shortTitle ?? model.bill.title;
  header.appendChild(
    el(
      "p",
      { class: "hero-sub" },
      `The ${shortTitle} would rewrite U.S. digital-asset market structure. Every member's vote, next to their disclosed Bitcoin exposure — and Congress's most-watched traders.`,
    ),
  );
  return header;
}
