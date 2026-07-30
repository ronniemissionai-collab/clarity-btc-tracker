/** Display labels for securities (ticker + kind, disambiguating the two "BTC"s). */
import type { SecurityKind } from "@clarity-btc/shared";
import { el } from "../dom";
import type { HoldingRow } from "../derive";

export const KIND_LABELS: Record<SecurityKind | "other", string> = {
  other: "stock",
  direct: "direct",
  "spot-etf": "spot ETF",
  treasury: "BTC treasury",
  miner: "miner",
  exchange: "exchange",
  "futures-etf": "futures ETF",
};

/** "BTC direct" / "IBIT spot ETF"; `name` (when resolved) becomes a tooltip. */
export function securityRefLabel(ref: { ticker: string; kind: SecurityKind | "other" }, name?: string): HTMLElement {
  const attrs: Record<string, string> = { class: "sec" };
  if (name !== undefined) attrs["title"] = name;
  return el(
    "span",
    attrs,
    el("b", {}, ref.ticker),
    " ",
    el("small", { class: "muted" }, KIND_LABELS[ref.kind]),
  );
}

/** Label for a holdings-view row, with the universe's full fund name as a tooltip. */
export function securityLabel(row: HoldingRow): HTMLElement {
  return securityRefLabel(row.holding.security, row.security?.name);
}
