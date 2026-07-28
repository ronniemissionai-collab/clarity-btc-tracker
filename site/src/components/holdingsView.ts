/**
 * "Bitcoin holdings" tab: stat cards, party/tier filter toolbar, Tier 1
 * party columns, and the Tier 2 subordinate table.
 */
import type { Party } from "@clarity-btc/shared";
import { el, replaceChildren } from "../dom";
import type { Model } from "../derive";
import { renderPartyColumns } from "./columns";
import { renderStatCards } from "./statCards";
import { createTier2Table } from "./table";

type PartyFilter = Party | "all";
type TierFilter = "all" | "1" | "2";

function selectControl(
  labelText: string,
  options: readonly { value: string; label: string }[],
  onChange: (value: string) => void,
): HTMLLabelElement {
  const select = el("select", {});
  for (const option of options) {
    select.appendChild(el("option", { value: option.value }, option.label));
  }
  select.addEventListener("change", () => onChange(select.value));
  return el("label", { class: "control" }, el("span", { class: "control-label" }, labelText), select);
}

export function renderHoldingsView(model: Model): HTMLElement {
  const view = el("section", { class: "view" });
  let partyFilter: PartyFilter = "all";
  let tierFilter: TierFilter = "all";

  view.appendChild(renderStatCards(model));

  // Filter toolbar
  const partiesPresent = new Set<Party>([
    ...model.tier1Columns.keys(),
    ...model.tier2Rows.map((r) => r.member.party),
  ]);
  const partyOptions: { value: string; label: string }[] = [{ value: "all", label: "All parties" }];
  if (partiesPresent.has("R")) partyOptions.push({ value: "R", label: "Republicans" });
  if (partiesPresent.has("D")) partyOptions.push({ value: "D", label: "Democrats" });
  if (partiesPresent.has("I")) partyOptions.push({ value: "I", label: "Independents" });

  const toolbar = el("form", { class: "toolbar", "aria-label": "Filter holdings" });
  toolbar.addEventListener("submit", (event) => event.preventDefault());
  toolbar.appendChild(
    selectControl("Party", partyOptions, (value) => {
      partyFilter = value as PartyFilter;
      applyFilters();
    }),
  );
  toolbar.appendChild(
    selectControl(
      "Tier",
      [
        { value: "all", label: "Both tiers" },
        { value: "1", label: "Tier 1 — direct BTC, spot ETFs, treasuries" },
        { value: "2", label: "Tier 2 — miners, exchanges, futures ETFs" },
      ],
      (value) => {
        tierFilter = value as TierFilter;
        applyFilters();
      },
    ),
  );
  view.appendChild(toolbar);

  // Tier 1 columns
  const tier1Section = el("div", {});
  const columnsMount = el("div", {});
  columnsMount.appendChild(renderPartyColumns(model, partyFilter));
  tier1Section.appendChild(columnsMount);
  view.appendChild(tier1Section);

  // Tier 2 table
  const tier2Section = el("div", {});
  const tier2Heading = el("h2", { class: "tier2-head" }, "Tier 2 — adjacent exposure ");
  tier2Heading.appendChild(el("small", { class: "muted" }, "(miners, exchanges, futures ETFs)"));
  tier2Section.appendChild(tier2Heading);
  const table = createTier2Table(model);
  tier2Section.appendChild(table.root);
  view.appendChild(tier2Section);

  const applyFilters = (): void => {
    tier1Section.hidden = tierFilter === "2";
    tier2Section.hidden = tierFilter === "1";
    replaceChildren(columnsMount, renderPartyColumns(model, partyFilter));
    table.update(
      partyFilter === "all"
        ? model.tier2Rows
        : model.tier2Rows.filter((r) => r.member.party === partyFilter),
    );
  };
  applyFilters();

  return view;
}
