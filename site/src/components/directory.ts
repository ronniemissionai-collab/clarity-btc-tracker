/**
 * "All traders" directory tab: every member with disclosed trades, fed by a
 * lazy fetch of /data/portfolio/index.json on first open. Search by name or
 * state, sort by trade count / last trade / name, party + active filter
 * chips; each row links to the member portfolio view (#member/{id}).
 */
import { el, replaceChildren } from "../dom";
import { fmtDate } from "../format";
import { fetchDirectory, type DirectoryEntry } from "../portfolioData";
import { chip, partyChip } from "./flags";

export type DirectorySortKey = "trades" | "lastTrade" | "name";

interface DirectoryFilters {
  query: string;
  sort: DirectorySortKey;
  parties: ReadonlySet<DirectoryEntry["party"]>;
  activeOnly: boolean;
}

/** Pure filter + sort over directory entries (unit-tested directly). */
export function filterDirectory(
  entries: readonly DirectoryEntry[],
  filters: DirectoryFilters,
): DirectoryEntry[] {
  const query = filters.query.trim().toLowerCase();
  const matched = entries.filter((entry) => {
    if (filters.parties.size > 0 && !filters.parties.has(entry.party)) return false;
    if (filters.activeOnly && !entry.active) return false;
    if (query.length > 0) {
      const name = entry.name.toLowerCase();
      const state = entry.state.toLowerCase();
      if (!name.includes(query) && state !== query) return false;
    }
    return true;
  });
  return matched.sort((a, b) => {
    switch (filters.sort) {
      case "trades":
        return b.tradeCount - a.tradeCount || a.name.localeCompare(b.name);
      case "lastTrade":
        return b.lastTradeDate.localeCompare(a.lastTradeDate) || a.name.localeCompare(b.name);
      case "name":
        return a.name.localeCompare(b.name);
    }
  });
}

function entryRow(entry: DirectoryEntry): HTMLTableRowElement {
  const tr = el("tr", {});

  const memberCell = el("td", {});
  memberCell.appendChild(
    el(
      "a",
      { class: "dir-link", href: `#member/${entry.memberId}` },
      el("b", {}, entry.name),
    ),
  );
  memberCell.appendChild(el("br"));
  memberCell.appendChild(
    el("small", { class: "muted" }, entry.chamber === "house" ? "House" : "Senate"),
  );
  tr.appendChild(memberCell);

  const chipsCell = el("td", {}, partyChip(entry));
  if (!entry.active) {
    chipsCell.append(" ", chip("no longer serving", "stale", "Departed Congress — historical filings only"));
  }
  if (entry.rosterMember) {
    chipsCell.append(" ", chip("tracked", "neutral", "On the portfolio-tracker roster (has a trader card)"));
  }
  tr.appendChild(chipsCell);

  tr.appendChild(el("td", {}, el("span", { class: "num" }, String(entry.tradeCount))));
  tr.appendChild(el("td", {}, el("span", { class: "num" }, fmtDate(entry.lastTradeDate))));
  return tr;
}

export interface DirectoryView {
  view: HTMLElement;
  /** Kick off the lazy index fetch; safe to call repeatedly. */
  load: () => void;
}

export function renderDirectoryView(
  loadIndex: () => Promise<DirectoryEntry[]> = fetchDirectory,
): DirectoryView {
  const view = el("section", { class: "view" });
  view.appendChild(
    el(
      "p",
      { class: "view-intro muted" },
      "Every member of Congress with disclosed STOCK Act trades — all tickers, not just the Bitcoin universe. Open a member for their full portfolio, trade history and filings.",
    ),
  );

  const mount = el("div", {});
  view.appendChild(mount);

  let entries: DirectoryEntry[] | null = null;
  let requested = false;
  const filters: DirectoryFilters & { parties: Set<DirectoryEntry["party"]> } = {
    query: "",
    sort: "trades",
    parties: new Set(),
    activeOnly: false,
  };

  const renderLoading = (): void => {
    replaceChildren(
      mount,
      el("p", { class: "muted lazy-status", role: "status" }, "Loading the member directory…"),
    );
  };

  const renderLoadError = (error: unknown): void => {
    const box = el("div", { class: "lazy-error", role: "alert" });
    box.appendChild(el("p", { class: "muted" }, "The member directory failed to load."));
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

  // --- results (built once the index has loaded) ---------------------------
  const buildResults = (all: DirectoryEntry[]): void => {
    const toolbar = el("form", { class: "toolbar", "aria-label": "Filter the member directory" });
    toolbar.addEventListener("submit", (event) => event.preventDefault());

    const search = el("input", {
      type: "search",
      class: "dir-search",
      placeholder: "Name or state (e.g. TX)",
      "aria-label": "Search members by name or state",
    });
    search.addEventListener("input", () => {
      filters.query = search.value;
      renderRows();
    });
    toolbar.appendChild(
      el("label", { class: "control" }, el("span", { class: "control-label" }, "Search"), search),
    );

    const sort = el("select", { "aria-label": "Sort members" });
    sort.appendChild(el("option", { value: "trades" }, "Most trades"));
    sort.appendChild(el("option", { value: "lastTrade" }, "Latest trade"));
    sort.appendChild(el("option", { value: "name" }, "Name A–Z"));
    sort.addEventListener("change", () => {
      filters.sort = sort.value as DirectorySortKey;
      renderRows();
    });
    toolbar.appendChild(
      el("label", { class: "control" }, el("span", { class: "control-label" }, "Sort"), sort),
    );

    const chipGroup = el("div", { class: "control", role: "group", "aria-label": "Filter chips" });
    const partiesPresent = new Set(all.map((entry) => entry.party));
    const partyLabels = { R: "R", D: "D", I: "I" } as const;
    for (const party of ["R", "D", "I"] as const) {
      if (!partiesPresent.has(party)) continue;
      const button = el(
        "button",
        { class: `chip-btn ${party.toLowerCase()}`, type: "button", "aria-pressed": "false" },
        partyLabels[party],
      );
      button.addEventListener("click", () => {
        if (filters.parties.has(party)) filters.parties.delete(party);
        else filters.parties.add(party);
        button.setAttribute("aria-pressed", String(filters.parties.has(party)));
        renderRows();
      });
      chipGroup.appendChild(button);
    }
    const activeBtn = el(
      "button",
      { class: "chip-btn", type: "button", "aria-pressed": "false" },
      "serving now",
    );
    activeBtn.addEventListener("click", () => {
      filters.activeOnly = !filters.activeOnly;
      activeBtn.setAttribute("aria-pressed", String(filters.activeOnly));
      renderRows();
    });
    chipGroup.appendChild(activeBtn);
    toolbar.appendChild(chipGroup);

    const count = el("p", { class: "muted dir-count", role: "status" });
    const tbody = el("tbody", {});
    const table = el(
      "table",
      { class: "dir-table" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "col" }, "Member"),
          el("th", { scope: "col" }, "Party"),
          el("th", { scope: "col" }, "Trades"),
          el("th", { scope: "col" }, "Last trade"),
        ),
      ),
      tbody,
    );
    const tablebox = el(
      "div",
      { class: "tablebox", tabindex: 0, "aria-label": "Member directory table" },
      table,
    );

    const renderRows = (): void => {
      const rows = filterDirectory(all, filters);
      count.textContent =
        rows.length === all.length
          ? `${all.length} members with disclosed trades`
          : `${rows.length} of ${all.length} members match`;
      if (rows.length === 0) {
        const empty = el("tr", {});
        empty.appendChild(
          el(
            "td",
            { colspan: 4, class: "empty muted" },
            "No members match the current search and filters.",
          ),
        );
        replaceChildren(tbody, empty);
        return;
      }
      replaceChildren(tbody, ...rows.map(entryRow));
    };

    renderRows();
    replaceChildren(mount, toolbar, count, tablebox);
  };

  const load = (): void => {
    if (requested) return;
    requested = true;
    if (entries !== null) return;
    renderLoading();
    loadIndex().then(
      (loaded) => {
        entries = loaded;
        buildResults(loaded);
      },
      (error: unknown) => {
        renderLoadError(error);
      },
    );
  };

  return { view, load };
}
