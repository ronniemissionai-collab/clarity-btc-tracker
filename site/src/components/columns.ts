/**
 * Tier 1 party-split columns (Variant B organ): red/blue headed columns, one
 * block per member with their CLARITY vote chip and, per holding, epistemics
 * chips, the disclosed range linked to its official filing, and a lo–hi range
 * bar on a shared scale.
 */
import type { Party } from "@clarity-btc/shared";
import { el } from "../dom";
import { fmtRange } from "../format";
import type { MemberGroup, Model } from "../derive";
import { holdingFlagChips, voteChip } from "./flags";
import { renderRangeBar } from "./rangebar";
import { securityLabel } from "./security";

const PARTY_ORDER: readonly Party[] = ["R", "D", "I"];
const PARTY_NAMES: Record<Party, string> = {
  R: "Republicans",
  D: "Democrats",
  I: "Independents",
};
const COLUMN_CLASS: Record<Party, string> = { R: "rep", D: "dem", I: "ind" };

function renderMember(group: MemberGroup, model: Model): HTMLElement {
  const { member } = group;
  const article = el("article", { class: "member" });

  const head = el("div", { class: "member-head" });
  const who = el("span", {});
  who.append(
    el("b", {}, member.name),
    " ",
    el(
      "small",
      { class: "muted" },
      `${member.state} · ${member.chamber === "house" ? "House" : "Senate"}`,
    ),
  );
  head.append(who, voteChip(model.voteFor(member)));
  article.appendChild(head);

  for (const row of group.rows) {
    const line = el("div", { class: "holding" });
    const left = el("span", { class: "holding-sec" }, securityLabel(row), " ");
    for (const flag of holdingFlagChips(row.holding)) left.append(" ", flag);
    line.appendChild(left);

    const right = el("span", { class: "holding-val" });
    right.appendChild(
      el(
        "a",
        {
          class: `num range-link${row.holding.status === "sold" ? " sold-range" : ""}`,
          href: row.filingUrl,
          rel: "noopener",
          title: "Official filing",
        },
        fmtRange(row.holding.range),
      ),
    );
    if (row.holding.status !== "sold") {
      right.appendChild(renderRangeBar(row.holding.range, model.tier1MaxHi));
    }
    line.appendChild(right);
    article.appendChild(line);
  }

  if (member.note !== undefined) {
    article.appendChild(el("small", { class: "member-note muted" }, member.note));
  }
  return article;
}

export function renderPartyColumns(model: Model, partyFilter: Party | "all"): HTMLElement {
  const wrap = el("div", { class: "cols" });
  let rendered = 0;

  for (const party of PARTY_ORDER) {
    if (partyFilter !== "all" && party !== partyFilter) continue;
    const groups = model.tier1Columns.get(party);
    if (!groups || groups.length === 0) continue;
    rendered += 1;

    const column = el("section", {
      class: `col ${COLUMN_CLASS[party]}`,
      "aria-label": `${PARTY_NAMES[party]} — Tier 1 holders`,
    });
    const holderCount = model.tier1HoldersByParty.get(party) ?? 0;
    const heading = el("h3", { class: "col-head" }, PARTY_NAMES[party]);
    heading.appendChild(el("span", { class: "num col-count" }, String(holderCount)));
    column.appendChild(heading);
    for (const group of groups) column.appendChild(renderMember(group, model));
    wrap.appendChild(column);
  }

  if (rendered === 0) {
    wrap.appendChild(el("p", { class: "empty muted" }, "No Tier 1 holders match this filter."));
  }
  return wrap;
}
