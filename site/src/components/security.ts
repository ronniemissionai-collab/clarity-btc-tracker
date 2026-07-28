/** Display labels for securities (ticker + kind, disambiguating the two "BTC"s). */
import type { SecurityKind } from "@clarity-btc/shared";
import { el } from "../dom";
import type { HoldingRow } from "../derive";

export const KIND_LABELS: Record<SecurityKind, string> = {
  direct: "direct",
  "spot-etf": "spot ETF",
  treasury: "BTC treasury",
  miner: "miner",
  exchange: "exchange",
  "futures-etf": "futures ETF",
};

/** "BTC direct" / "IBIT spot ETF" with the full fund name as a tooltip. */
export function securityLabel(row: HoldingRow): HTMLElement {
  const attrs: Record<string, string> = { class: "sec" };
  if (row.security) attrs["title"] = row.security.name;
  return el(
    "span",
    attrs,
    el("b", {}, row.holding.security.ticker),
    " ",
    el("small", { class: "muted" }, KIND_LABELS[row.holding.security.kind]),
  );
}
