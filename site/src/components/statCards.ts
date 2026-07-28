/**
 * Summary stat cards for the holdings view: House vote, R/D Tier 1 holders,
 * combined disclosed exposure — all computed from data.
 */
import { el } from "../dom";
import { fmtDate, fmtTally, fmtUsd, NDASH } from "../format";
import type { Model } from "../derive";

interface Card {
  label: string;
  value: string;
  variant?: "rep" | "dem";
  detail?: string;
}

export function renderStatCards(model: Model): HTMLElement {
  const cards: Card[] = [];

  if (model.housePassage) {
    cards.push({
      label: "House vote",
      value: fmtTally(model.housePassage.yea, model.housePassage.nay),
      detail: fmtDate(model.housePassage.date),
    });
  }
  cards.push({
    label: "R holders (Tier 1)",
    value: String(model.tier1HoldersByParty.get("R") ?? 0),
    variant: "rep",
  });
  cards.push({
    label: "D holders (Tier 1)",
    value: String(model.tier1HoldersByParty.get("D") ?? 0),
    variant: "dem",
  });
  if ((model.tier1HoldersByParty.get("I") ?? 0) > 0) {
    cards.push({ label: "I holders (Tier 1)", value: String(model.tier1HoldersByParty.get("I")) });
  }
  cards.push({
    label: "Combined disclosed exposure",
    value: `${fmtUsd(model.combinedExposure.lo)}${NDASH}${fmtUsd(model.combinedExposure.hi)}`,
    detail: "sum of disclosed ranges",
  });

  const grid = el("div", { class: "statcards" });
  for (const card of cards) {
    const div = el("div", { class: "statcard" });
    div.appendChild(el("p", { class: "eyebrow" }, card.label));
    const value = el("b", { class: `num statvalue${card.variant ? ` ${card.variant}` : ""}` }, card.value);
    div.appendChild(value);
    if (card.detail) div.appendChild(el("small", { class: "statdetail" }, card.detail));
    grid.appendChild(div);
  }
  return grid;
}
