/**
 * "Common holdings" tab (v1.2, build ticket 17): securities currently held by
 * two or more members, fed by a lazy fetch of /data/common.json on first
 * open. Table rows show the security, the distinct current-owner count, a
 * crimson/cobalt party-split mini bar and the most recent disclosed buy date;
 * each row expands (button, aria-expanded) to the owners — name linking to
 * #member/{id}, party chip, their buy dates, disclosed range, and SOLD /
 * no-longer-serving chips where applicable. Sortable by owners / latest buy.
 */
import type { CommonHolding, CommonHoldingOwner } from "@clarity-btc/shared";
import { el, replaceChildren } from "../dom";
import { fmtDate, fmtRange } from "../format";
import { fetchCommonHoldings } from "../portfolioData";
import { chip, partyChip } from "./flags";
import { securityRefLabel } from "./security";

export type CommonSortKey = "owners" | "latestBuy";

/** Pure sort over common-holdings rows (unit-tested directly). */
export function sortCommonHoldings(
  rows: readonly CommonHolding[],
  sort: CommonSortKey,
): CommonHolding[] {
  const byOwners = (a: CommonHolding, b: CommonHolding): number =>
    b.ownersCount - a.ownersCount ||
    a.security.ticker.localeCompare(b.security.ticker) ||
    a.security.kind.localeCompare(b.security.kind);
  return [...rows].sort((a, b) => {
    if (sort === "latestBuy") {
      // Most recent disclosed buy first; annual-only rows (null) sort last.
      const cmp = (b.latestBuyDate ?? "").localeCompare(a.latestBuyDate ?? "");
      if (cmp !== 0) return cmp;
    }
    return byOwners(a, b);
  });
}

/** Crimson/cobalt party-split mini bar; counts are current owners only. */
function splitBar(split: CommonHolding["partySplit"]): HTMLElement {
  const parts = (["R", "D", "I"] as const).filter((p) => split[p] > 0);
  const label = parts.map((p) => `${split[p]} ${p}`).join(", ");
  const bar = el("div", { class: "splitbar", role: "img", "aria-label": `Party split: ${label}` });
  for (const party of parts) {
    bar.appendChild(
      el("span", { class: `splitseg ${party.toLowerCase()}`, style: `flex-grow: ${split[party]}` }),
    );
  }
  return bar;
}

function ownerItem(owner: CommonHoldingOwner): HTMLLIElement {
  const li = el("li", { class: "common-owner" });

  const who = el("span", { class: "common-owner-who" });
  who.appendChild(el("a", { class: "dir-link", href: `#member/${owner.memberId}` }, el("b", {}, owner.name)));
  who.append(" ", partyChip(owner));
  if (owner.status === "sold") {
    who.append(" ", chip("SOLD", "sold", "Disclosed a full exit — not a current holder, not counted"));
  }
  if (owner.status === "stale") {
    who.append(" ", chip("stale", "stale", "Last confirmed on an older filing; needs re-verification"));
  }
  if (!owner.active) {
    who.append(" ", chip("no longer serving", "stale", "Departed Congress — historical filings only"));
  }
  li.appendChild(who);

  const buys = el("span", { class: "muted common-owner-buys" });
  buys.append(
    owner.buyDates.length > 0
      ? `Buys: ${owner.buyDates.map(fmtDate).join(", ")}`
      : "No disclosed buys in our coverage — position from an annual report",
  );
  li.appendChild(buys);

  li.appendChild(
    el(
      "span",
      { class: `num common-owner-range${owner.status === "sold" ? " sold-range" : ""}` },
      fmtRange(owner.latestRange),
    ),
  );
  return li;
}

function detailCell(row: CommonHolding): HTMLTableCellElement {
  const cell = el("td", { colspan: 5 });
  const list = el("ul", { class: "common-owners" });
  for (const owner of row.owners) list.appendChild(ownerItem(owner));
  cell.appendChild(list);
  return cell;
}

interface RowPair {
  row: HTMLTableRowElement;
  detail: HTMLTableRowElement;
}

function securityRow(entry: CommonHolding, index: number): RowPair {
  const detailId = `common-owners-${index}`;
  const detail = el("tr", { class: "common-detail", id: detailId, hidden: true }, detailCell(entry));

  const tr = el("tr", { class: "common-row" });

  const toggleCell = el("td", { class: "common-toggle-cell" });
  const toggle = el(
    "button",
    {
      class: "expand-btn",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": detailId,
      "aria-label": `Show owners of ${entry.security.ticker}`,
      title: "Show owners",
    },
    "▸",
  );
  toggle.addEventListener("click", () => {
    const open = detail.hidden;
    detail.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "▾" : "▸";
  });
  toggleCell.appendChild(toggle);
  tr.appendChild(toggleCell);

  tr.appendChild(el("td", {}, securityRefLabel(entry.security, entry.name)));
  tr.appendChild(el("td", {}, el("span", { class: "num owners-count" }, String(entry.ownersCount))));
  tr.appendChild(el("td", {}, splitBar(entry.partySplit)));
  tr.appendChild(
    el(
      "td",
      {},
      entry.latestBuyDate === null
        ? el("small", { class: "muted" }, "annual report only")
        : el("span", { class: "num" }, fmtDate(entry.latestBuyDate)),
    ),
  );
  return { row: tr, detail };
}

export interface CommonHoldingsView {
  view: HTMLElement;
  /** Kick off the lazy /data/common.json fetch; safe to call repeatedly. */
  load: () => void;
}

export function renderCommonHoldingsView(
  loadCommon: () => Promise<CommonHolding[]> = fetchCommonHoldings,
): CommonHoldingsView {
  const view = el("section", { class: "view" });
  view.appendChild(
    el(
      "p",
      { class: "view-intro muted" },
      "Securities currently held by two or more members at once — every disclosed ticker, not just the Bitcoin universe. Counts come from derived positions, so a disclosed sale removes a member from the owner count.",
    ),
  );

  const mount = el("div", {});
  view.appendChild(mount);

  let rows: CommonHolding[] | null = null;
  let requested = false;
  let sort: CommonSortKey = "owners";

  const renderLoading = (): void => {
    replaceChildren(
      mount,
      el("p", { class: "muted lazy-status", role: "status" }, "Loading common holdings…"),
    );
  };

  const renderLoadError = (error: unknown): void => {
    const box = el("div", { class: "lazy-error", role: "alert" });
    box.appendChild(el("p", { class: "muted" }, "The common holdings failed to load."));
    box.appendChild(
      el("pre", { class: "errbox" }, error instanceof Error ? error.message : String(error)),
    );
    const retry = el("button", { class: "show-more", type: "button" }, "Try again");
    retry.addEventListener("click", () => {
      requested = false;
      load();
    });
    box.appendChild(retry);
    replaceChildren(mount, box);
  };

  const buildResults = (all: CommonHolding[]): void => {
    if (all.length === 0) {
      replaceChildren(
        mount,
        el(
          "p",
          { class: "muted empty" },
          "No security is currently held by two or more members — nothing to compare yet.",
        ),
      );
      return;
    }

    const toolbar = el("form", { class: "toolbar", "aria-label": "Sort the common holdings" });
    toolbar.addEventListener("submit", (event) => event.preventDefault());
    const sortSelect = el("select", { "aria-label": "Sort common holdings" });
    sortSelect.appendChild(el("option", { value: "owners" }, "Most owners"));
    sortSelect.appendChild(el("option", { value: "latestBuy" }, "Latest buy"));
    sortSelect.addEventListener("change", () => {
      sort = sortSelect.value as CommonSortKey;
      renderRows();
    });
    toolbar.appendChild(
      el("label", { class: "control" }, el("span", { class: "control-label" }, "Sort"), sortSelect),
    );

    const count = el(
      "p",
      { class: "muted dir-count", role: "status" },
      `${all.length} securities held by 2+ members`,
    );

    const tbody = el("tbody", {});
    const table = el(
      "table",
      { class: "common-table" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "col" }, el("span", { class: "visually-hidden" }, "Owners")),
          el("th", { scope: "col" }, "Security"),
          el("th", { scope: "col" }, "Members"),
          el("th", { scope: "col" }, "Party split"),
          el("th", { scope: "col" }, "Latest buy"),
        ),
      ),
      tbody,
    );
    const tablebox = el(
      "div",
      { class: "tablebox", tabindex: 0, "aria-label": "Common holdings table" },
      table,
    );

    const renderRows = (): void => {
      const ordered = sortCommonHoldings(all, sort);
      const nodes: HTMLTableRowElement[] = [];
      ordered.forEach((entry, i) => {
        const { row, detail } = securityRow(entry, i);
        nodes.push(row, detail);
      });
      replaceChildren(tbody, ...nodes);
    };

    renderRows();
    replaceChildren(mount, toolbar, count, tablebox);
  };

  const load = (): void => {
    if (requested) return;
    requested = true;
    if (rows !== null) return;
    renderLoading();
    loadCommon().then(
      (loaded) => {
        rows = loaded;
        buildResults(loaded);
      },
      (error: unknown) => {
        renderLoadError(error);
      },
    );
  };

  return { view, load };
}
