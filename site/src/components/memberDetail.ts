/**
 * Member portfolio view (#member/{id}): lazy fetch of
 * /data/portfolio/{id}.json, then the member header (party/chamber chips,
 * active flag), measured return vs SPY (always labelled an estimate), the
 * all-ticker positions table (owner + epistemics chips, official filing link
 * on every row), and the full trades timeline — windowed at 50 rows per
 * "Show more" so 3,000-trade members stay fast.
 */
import type { Member, PortfolioPosition, Trade, Trader } from "@clarity-btc/shared";
import { el, replaceChildren } from "../dom";
import { fmtDate, fmtRange, fmtSignedPct, fmtSignedPp } from "../format";
import { fetchPortfolio, type MemberPortfolio } from "../portfolioData";
import { chip, holdingFlagChips, partyChip } from "./flags";
import { securityRefLabel } from "./security";
import { renderSparkline } from "./sparkline";

/** Trades rendered per "Show more" click. */
export const TRADE_PAGE_SIZE = 50;

function memberHeader(member: Member, portfolio: MemberPortfolio): HTMLElement {
  const header = el("header", { class: "member-hero" });
  header.appendChild(el("p", { class: "eyebrow" }, "Member portfolio"));
  header.appendChild(el("h1", { class: "member-title" }, member.name));
  const chips = el("div", { class: "member-chips" });
  chips.appendChild(partyChip(member));
  chips.appendChild(chip(member.chamber === "house" ? "House" : "Senate"));
  if (member.district !== undefined) chips.appendChild(chip(member.district));
  if (!member.active) {
    chips.appendChild(chip("no longer serving", "stale", "Departed Congress — historical filings only"));
  }
  if (member.traderRoster !== undefined) {
    chips.appendChild(chip("tracked", "neutral", "On the portfolio-tracker roster (has a trader card)"));
  }
  header.appendChild(chips);
  if (member.note !== undefined) {
    header.appendChild(el("p", { class: "muted member-note" }, member.note));
  }
  header.appendChild(renderSparkline(portfolio.series, member.name));
  return header;
}

function measuredSection(measured: Trader["measured"]): HTMLElement {
  const section = el("section", { class: "detail-section measured-panel" });
  section.appendChild(el("h2", { class: "detail-head" }, "Measured return"));
  if (!measured) {
    section.appendChild(
      el(
        "p",
        { class: "muted empty" },
        "Not yet measured — the returns step has not priced this member's disclosed buys.",
      ),
    );
    return section;
  }
  const sign = measured.return > 0 ? "gain" : measured.return < 0 ? "loss" : "flat";
  const line = el("p", { class: "measured-line" });
  const attrs: Record<string, string> = { class: `num measured-value ${sign}` };
  if (measured.window !== undefined) attrs["title"] = measured.window;
  line.appendChild(el("b", attrs, fmtSignedPct(measured.return)));
  if (measured.excess !== undefined) {
    line.appendChild(
      el("span", { class: "muted measured-excess" }, `${fmtSignedPp(measured.excess)} vs ${measured.benchmark}`),
    );
  }
  line.append(" ");
  line.appendChild(
    chip("estimate", "neutral", "Range-midpoint method — disclosure bands make exact returns unknowable"),
  );
  section.appendChild(line);
  const caveat =
    "Estimated from disclosed value ranges (midpoint method) against daily closes, benchmarked to SPY." +
    (measured.window !== undefined ? ` Window: ${measured.window}.` : "");
  section.appendChild(el("p", { class: "muted methodnote measured-note" }, caveat));
  if (measured.note !== undefined) {
    section.appendChild(el("p", { class: "muted methodnote" }, measured.note));
  }
  return section;
}

function positionRow(holding: PortfolioPosition): HTMLTableRowElement | null {
  const filing = holding.sources.find((s) => s.kind === "filing");
  if (!filing) return null; // schema makes this unreachable; never render an unlinked row
  const tr = el("tr", {});
  tr.appendChild(el("td", {}, securityRefLabel(holding.security)));
  tr.appendChild(
    el(
      "td",
      {},
      holding.owner === "self"
        ? el("small", { class: "muted" }, "self")
        : chip(holding.owner, "owner", `Held by ${holding.owner}, attributed to the member`),
    ),
  );
  tr.appendChild(
    el(
      "td",
      {},
      el(
        "span",
        { class: `num${holding.status === "sold" ? " sold-range" : ""}` },
        fmtRange(holding.range),
      ),
    ),
  );
  const flagsCell = el("td", {});
  const flags = holdingFlagChips(holding, { owner: false });
  if (flags.length === 0) flagsCell.appendChild(el("small", { class: "muted" }, "—"));
  for (const flag of flags) flagsCell.append(flag, " ");
  tr.appendChild(flagsCell);
  tr.appendChild(
    el("td", {}, el("a", { href: filing.url, rel: "noopener", title: filing.title ?? "Official filing" }, "filing ↗")),
  );
  return tr;
}

function positionsSection(positions: PortfolioPosition[]): HTMLElement {
  const section = el("section", { class: "detail-section" });
  section.appendChild(el("h2", { class: "detail-head" }, `Positions (${positions.length})`));
  if (positions.length === 0) {
    section.appendChild(
      el("p", { class: "muted empty" }, "No disclosed positions derivable from this member's filings."),
    );
    return section;
  }
  const tbody = el("tbody", {});
  for (const holding of positions) {
    const row = positionRow(holding);
    if (row) tbody.appendChild(row);
  }
  const table = el(
    "table",
    { class: "positions-table" },
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { scope: "col" }, "Security"),
        el("th", { scope: "col" }, "Owner"),
        el("th", { scope: "col" }, "Disclosed range"),
        el("th", { scope: "col" }, "Flags"),
        el("th", { scope: "col" }, "Filing"),
      ),
    ),
    tbody,
  );
  section.appendChild(
    el("div", { class: "tablebox", tabindex: 0, "aria-label": "Positions table" }, table),
  );
  return section;
}

function tradeRow(trade: Trade): HTMLTableRowElement {
  const tr = el("tr", {});
  tr.appendChild(el("td", {}, el("span", { class: "num" }, fmtDate(trade.transactionDate))));

  const what = el("td", { class: "trade-what" });
  what.appendChild(chip(trade.side === "buy" ? "BUY" : "SELL", trade.side));
  what.append(" ", trade.assetRaw);
  if (trade.owner !== undefined && trade.owner !== "self") {
    what.append(" ", chip(trade.owner, "owner", `Held by ${trade.owner}, attributed to the member`));
  }
  if (trade.late) {
    what.append(" ", chip("late filing", "stale", "Filed outside the STOCK Act 45-day window"));
  }
  tr.appendChild(what);

  tr.appendChild(el("td", {}, el("span", { class: "num" }, fmtRange(trade.range))));
  tr.appendChild(
    el(
      "td",
      {},
      el(
        "a",
        { href: trade.docUrl, rel: "noopener", title: `Filed ${fmtDate(trade.filedDate)} — official filing` },
        "filing ↗",
      ),
    ),
  );
  return tr;
}

function tradesSection(trades: Trade[]): HTMLElement {
  const section = el("section", { class: "detail-section" });
  section.appendChild(el("h2", { class: "detail-head" }, `Trades (${trades.length})`));
  if (trades.length === 0) {
    section.appendChild(el("p", { class: "muted empty" }, "No disclosed trades on file."));
    return section;
  }

  // Newest first, whatever order the file shipped in.
  const ordered = [...trades].sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));

  const tbody = el("tbody", {});
  const table = el(
    "table",
    { class: "trades-table" },
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { scope: "col" }, "Date"),
        el("th", { scope: "col" }, "Trade"),
        el("th", { scope: "col" }, "Disclosed range"),
        el("th", { scope: "col" }, "Filing"),
      ),
    ),
    tbody,
  );
  section.appendChild(
    el("div", { class: "tablebox", tabindex: 0, "aria-label": "Trades timeline table" }, table),
  );

  // Windowed rendering: only `shown` rows exist in the DOM at any time.
  let shown = 0;
  const more = el("button", { class: "show-more", type: "button" });
  const showMore = (): void => {
    const next = ordered.slice(shown, shown + TRADE_PAGE_SIZE);
    for (const trade of next) tbody.appendChild(tradeRow(trade));
    shown += next.length;
    const remaining = ordered.length - shown;
    if (remaining > 0) {
      more.textContent = `Show ${Math.min(TRADE_PAGE_SIZE, remaining)} more (${remaining.toLocaleString("en-US")} remaining)`;
    } else {
      more.remove();
    }
  };
  showMore();
  more.addEventListener("click", showMore);
  if (shown < ordered.length) section.appendChild(more);
  return section;
}

export function renderMemberDetail(portfolio: MemberPortfolio): HTMLElement {
  const article = el("article", { class: "member-detail" });
  article.appendChild(memberHeader(portfolio.member, portfolio));
  article.appendChild(measuredSection(portfolio.measured));
  article.appendChild(positionsSection(portfolio.positions));
  article.appendChild(tradesSection(portfolio.trades));
  article.appendChild(
    el(
      "p",
      { class: "muted methodnote" },
      "All rows come from official STOCK Act filings and report value ranges, never exact amounts. “Disclosed a trade” is not proof of a current position.",
    ),
  );
  return article;
}

/**
 * Mount the member view: loading state, lazy fetch, then the detail render —
 * or an honest error state with the failure message.
 */
export function renderMemberPage(
  memberId: string,
  loadPortfolio: (id: string) => Promise<MemberPortfolio> = fetchPortfolio,
): HTMLElement {
  const mount = el("div", { class: "member-mount" });
  replaceChildren(
    mount,
    el("p", { class: "muted lazy-status", role: "status" }, `Loading portfolio ${memberId}…`),
  );
  loadPortfolio(memberId).then(
    (portfolio) => {
      replaceChildren(mount, renderMemberDetail(portfolio));
    },
    (error: unknown) => {
      const box = el("div", { class: "lazy-error", role: "alert" });
      box.appendChild(el("p", { class: "muted" }, `The portfolio for ${memberId} failed to load.`));
      box.appendChild(
        el("pre", { class: "errbox" }, error instanceof Error ? error.message : String(error)),
      );
      replaceChildren(mount, box);
    },
  );
  return mount;
}
