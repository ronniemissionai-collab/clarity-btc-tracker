/**
 * Tier 2 subordinate table (dense Variant A organ) with sortable headers:
 * by disclosed-range hi, member name, or party. Wide content scrolls inside
 * its own container so the page never scrolls horizontally.
 */
import { el, replaceChildren } from "../dom";
import { fmtRange } from "../format";
import type { HoldingRow, Model } from "../derive";
import { holdingFlagChips, partyChip, voteChip } from "./flags";
import { securityLabel } from "./security";

export type SortKey = "range" | "name" | "party";
export type SortDir = 1 | -1;

export function compareRows(a: HoldingRow, b: HoldingRow, key: SortKey): number {
  switch (key) {
    case "range":
      return a.holding.range.hi - b.holding.range.hi || a.member.name.localeCompare(b.member.name);
    case "name":
      return a.member.name.localeCompare(b.member.name);
    case "party":
      return a.member.party.localeCompare(b.member.party) || a.member.name.localeCompare(b.member.name);
  }
}

export function sortRows(rows: readonly HoldingRow[], key: SortKey, dir: SortDir): HoldingRow[] {
  return [...rows].sort((a, b) => compareRows(a, b, key) * dir);
}

const DEFAULT_DIR: Record<SortKey, SortDir> = { range: -1, name: 1, party: 1 };

interface Column {
  label: string;
  sort?: SortKey;
}

const COLUMNS: Column[] = [
  { label: "Member", sort: "name" },
  { label: "Party", sort: "party" },
  { label: "CLARITY vote" },
  { label: "Holding" },
  { label: "Disclosed range", sort: "range" },
  { label: "Filing" },
];

export interface Tier2Table {
  root: HTMLElement;
  /** Re-render the body with a (possibly filtered) row set; sort state is kept. */
  update(rows: readonly HoldingRow[]): void;
}

export function createTier2Table(model: Model): Tier2Table {
  let sortKey: SortKey = "range";
  let sortDir: SortDir = DEFAULT_DIR["range"];
  let currentRows: readonly HoldingRow[] = model.tier2Rows;

  const tbody = el("tbody", {});
  const headerCells = new Map<SortKey, HTMLTableCellElement>();

  const renderBody = (): void => {
    const rows = sortRows(currentRows, sortKey, sortDir);
    const rendered = rows.map((row) => {
      const tr = el("tr", {});
      const memberCell = el("td", {}, el("b", {}, row.member.name), el("br"));
      memberCell.appendChild(
        el(
          "small",
          { class: "muted" },
          `${row.member.chamber === "house" ? "House" : "Senate"}${
            row.holding.note !== undefined ? ` · ${row.holding.note}` : ""
          }`,
        ),
      );
      tr.appendChild(memberCell);
      tr.appendChild(el("td", {}, partyChip(row.member)));
      tr.appendChild(el("td", {}, voteChip(model.voteFor(row.member))));
      const holdingCell = el("td", {}, securityLabel(row));
      for (const flag of holdingFlagChips(row.holding)) holdingCell.append(" ", flag);
      tr.appendChild(holdingCell);
      tr.appendChild(
        el(
          "td",
          {},
          el(
            "span",
            { class: `num${row.holding.status === "sold" ? " sold-range" : ""}` },
            fmtRange(row.holding.range),
          ),
        ),
      );
      tr.appendChild(
        el(
          "td",
          {},
          el(
            "a",
            { href: row.filingUrl, rel: "noopener", title: "Official filing" },
            "filing ↗",
          ),
        ),
      );
      return tr;
    });

    if (rendered.length === 0) {
      const empty = el("tr", {});
      empty.appendChild(
        el(
          "td",
          { colspan: COLUMNS.length, class: "empty muted" },
          "No Tier 2 (adjacent-exposure) rows match the current data and filters.",
        ),
      );
      replaceChildren(tbody, empty);
    } else {
      replaceChildren(tbody, ...rendered);
    }

    for (const [key, th] of headerCells) {
      th.setAttribute(
        "aria-sort",
        key === sortKey ? (sortDir === 1 ? "ascending" : "descending") : "none",
      );
    }
  };

  const headRow = el("tr", {});
  for (const column of COLUMNS) {
    if (!column.sort) {
      headRow.appendChild(el("th", { scope: "col" }, column.label));
      continue;
    }
    const key = column.sort;
    const button = el("button", { class: "th-sort", type: "button" }, column.label);
    button.addEventListener("click", () => {
      if (sortKey === key) sortDir = sortDir === 1 ? -1 : 1;
      else {
        sortKey = key;
        sortDir = DEFAULT_DIR[key];
      }
      renderBody();
    });
    const th = el("th", { scope: "col" }, button);
    headerCells.set(key, th);
    headRow.appendChild(th);
  }

  const table = el("table", {}, el("thead", {}, headRow), tbody);
  const root = el("div", { class: "tablebox", tabindex: 0, "aria-label": "Tier 2 holdings table" }, table);
  renderBody();

  return {
    root,
    update(rows) {
      currentRows = rows;
      renderBody();
    },
  };
}
