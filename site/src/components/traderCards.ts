/**
 * "Portfolio tracker" tab (Variant C organ): ranked trader cards — rank
 * numeral, party chip, real-data sparkline, trade count, and quoted X claims
 * beside measured returns (colored by sign, never asserted as fact).
 */
import type { Meta, Trader } from "@clarity-btc/shared";
import { el } from "../dom";
import { fmtDate, fmtSignedPct, fmtSignedPp } from "../format";
import type { Model, RankedTrader } from "../derive";
import { chip } from "./flags";
import { renderSparkline } from "./sparkline";

function claimsBlock(trader: Trader): HTMLElement {
  const block = el("div", { class: "trader-claims" });
  block.appendChild(el("span", { class: "eyebrow" }, "X claims"));
  if (trader.claims.length === 0) {
    block.appendChild(el("p", { class: "claim muted" }, "—"));
    return block;
  }
  for (const claim of trader.claims) {
    const p = el("p", { class: "claim" });
    p.append(`“${claim.quote}” `);
    p.appendChild(
      el(
        "a",
        { class: "claim-source", href: claim.sourceUrl, rel: "noopener" },
        claim.attribution ?? "source",
      ),
    );
    block.appendChild(p);
  }
  return block;
}

function measuredBlock(trader: Trader): HTMLElement {
  const block = el("div", { class: "trader-measured" });
  block.appendChild(el("span", { class: "eyebrow" }, "Measured"));
  const { measured } = trader;
  if (!measured) {
    block.appendChild(el("p", { class: "claim muted" }, "not yet measured"));
    return block;
  }
  const sign = measured.return > 0 ? "gain" : measured.return < 0 ? "loss" : "flat";
  const attrs: Record<string, string> = { class: `num measured-value ${sign}` };
  if (measured.window !== undefined) attrs["title"] = measured.window;
  block.appendChild(el("b", attrs, fmtSignedPct(measured.return)));
  if (measured.excess !== undefined) {
    block.appendChild(
      el("small", { class: "muted measured-excess" }, `${fmtSignedPp(measured.excess)} vs ${measured.benchmark}`),
    );
  }
  if (measured.note !== undefined) {
    block.appendChild(el("small", { class: "muted measured-note" }, measured.note));
  }
  return block;
}

function renderCard(ranked: RankedTrader): HTMLElement {
  const { trader, member } = ranked;
  const card = el("article", { class: "trader" });

  const head = el("div", { class: "trader-head" });
  head.appendChild(el("span", { class: "rank", "aria-label": `Rank ${ranked.rank}` }, String(ranked.rank).padStart(2, "0")));
  if (member) {
    head.appendChild(
      chip(
        `${member.party} · ${member.chamber === "house" ? "House" : "Senate"}`,
        member.party.toLowerCase(),
      ),
    );
  }
  if (trader.claimsSupported === false) {
    head.appendChild(
      chip(
        "reputation not supported by filings",
        "conflict",
        "The returns claimed for this trader do not match what their disclosed filings measure",
      ),
    );
  }
  card.appendChild(head);
  card.appendChild(el("h3", { class: "trader-name" }, member?.name ?? trader.memberId));

  card.appendChild(renderSparkline(ranked.series, member?.name ?? trader.memberId));

  const stats = el("div", { class: "trader-stats" });
  const trades = el("div", { class: "trader-trades" });
  trades.appendChild(el("span", { class: "eyebrow" }, "Trades"));
  trades.appendChild(el("b", { class: "num" }, String(trader.tradeCount)));
  stats.append(trades, claimsBlock(trader), measuredBlock(trader));
  card.appendChild(stats);

  card.appendChild(
    el("small", { class: "muted trader-attr" }, `Trades attributed to: ${trader.attribution}`),
  );
  if (trader.note !== undefined) {
    card.appendChild(el("small", { class: "muted trader-note" }, trader.note));
  }
  return card;
}

export function renderPortfolioView(model: Model, meta: Meta): HTMLElement {
  const view = el("section", { class: "view" });
  view.appendChild(
    el(
      "p",
      { class: "view-intro muted" },
      `Congress's most prolific traders, ranked by disclosed trade count — the returns X claims for them, next to what filings actually support. As of ${fmtDate(meta.asOf.traders)}.`,
    ),
  );
  const grid = el("div", { class: "traders" });
  for (const ranked of model.rankedTraders) grid.appendChild(renderCard(ranked));
  view.appendChild(grid);
  view.appendChild(
    el(
      "p",
      { class: "muted methodnote" },
      "Measured returns are estimated from disclosed value ranges (midpoint method) against daily closes, benchmarked to SPY — ranges make exact returns unknowable. Claims from X are shown as claims, never as fact.",
    ),
  );
  return view;
}
