// @vitest-environment happy-dom
/**
 * "Common holdings" tab (v1.2): lazy /data/common.json fetch (once, cached),
 * the security table (label, owner count, party-split mini bar, latest buy),
 * expandable owner rows with #member/{id} links + SOLD/inactive chips,
 * sorting by owners / latest buy, and honest loading / error / empty states.
 */
import { describe, expect, it } from "vitest";
import { parseCommonHoldings, type CommonHolding } from "@clarity-btc/shared";
import { renderCommonHoldingsView, sortCommonHoldings } from "../src/components/commonHoldings";
import commonFx from "./fixtures/common.json";

const rows = parseCommonHoldings(commonFx);

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function tickers(view: HTMLElement): string[] {
  return [...view.querySelectorAll("tbody tr.common-row .sec b")].map((b) => b.textContent ?? "");
}

async function loadedView(
  fixture: CommonHolding[] = rows,
): Promise<{ view: HTMLElement; calls: () => number }> {
  let calls = 0;
  const common = renderCommonHoldingsView(() => {
    calls += 1;
    return Promise.resolve(fixture);
  });
  common.load();
  common.load(); // second open must not refetch
  await flush();
  return { view: common.view, calls: () => calls };
}

describe("common.json contract parsing", () => {
  it("accepts the hand-made fixture and rejects malformed rows", () => {
    expect(rows).toHaveLength(3);
    expect(() => parseCommonHoldings([{ security: { ticker: "X" } }])).toThrow();
    // ownersCount must count exactly the non-sold owners.
    const bad = JSON.parse(JSON.stringify(commonFx)) as Array<{ ownersCount: number }>;
    bad[0]!.ownersCount = 4;
    expect(() => parseCommonHoldings(bad)).toThrow();
  });
});

describe("sortCommonHoldings", () => {
  it("sorts by owners desc then ticker, and by latest buy with annual-only rows last", () => {
    expect(sortCommonHoldings(rows, "owners").map((r) => r.security.ticker)).toEqual([
      "IBIT",
      "MSTR",
      "NVDA",
    ]);
    expect(sortCommonHoldings(rows, "latestBuy").map((r) => r.security.ticker)).toEqual([
      "NVDA",
      "IBIT",
      "MSTR", // latestBuyDate null - annual-report-only rows sort last
    ]);
  });
});

describe("common holdings view", () => {
  it("shows a loading state, fetches once, then renders one row per security", async () => {
    const { view, calls } = await loadedView();
    expect(calls()).toBe(1);
    expect(tickers(view)).toEqual(["IBIT", "MSTR", "NVDA"]);
    expect(view.textContent).toContain("3 securities held by 2+ members");
  });

  it("rows carry the owner count, party-split bar and latest buy date", async () => {
    const { view } = await loadedView();
    const ibit = view.querySelector("tbody tr.common-row")!;
    expect(ibit.querySelector(".owners-count")?.textContent).toBe("3");
    const bar = ibit.querySelector(".splitbar")!;
    expect(bar.getAttribute("aria-label")).toBe("Party split: 2 R, 1 D");
    // Crimson/cobalt segments, sized by count; no I segment for a 0 count.
    const segs = [...bar.querySelectorAll(".splitseg")];
    expect(segs.map((s) => s.className)).toEqual(["splitseg r", "splitseg d"]);
    expect(segs[0]?.getAttribute("style")).toContain("flex-grow: 2");
    expect(ibit.textContent).toContain("Jun 20, 2026");
    // The resolved security name ships as a tooltip on the label.
    expect(ibit.querySelector(".sec")?.getAttribute("title")).toBe("iShares Bitcoin Trust ETF");

    // An annual-report-only security is honest about having no buy date.
    const mstrRow = [...view.querySelectorAll("tbody tr.common-row")].find((tr) =>
      tr.textContent?.includes("MSTR"),
    );
    expect(mstrRow?.textContent).toContain("annual report only");
  });

  it("expands a row to the owners with member links, chips and buy dates", async () => {
    const { view } = await loadedView();
    const toggle = view.querySelector<HTMLButtonElement>("tbody .expand-btn");
    if (!toggle) throw new Error("expand button missing");
    const detail = view.querySelector<HTMLTableRowElement>(`#${toggle.getAttribute("aria-controls")}`);
    if (!detail) throw new Error("detail row missing");

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(detail.hidden).toBe(true);

    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(detail.hidden).toBe(false);

    // Four owners: three current + the exited one, each linking to #member/{id}.
    const links = [...detail.querySelectorAll<HTMLAnchorElement>("a.dir-link")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#member/P000197",
      "#member/M001243",
      "#member/L000571",
      "#member/G000596",
    ]);
    const owners = [...detail.querySelectorAll("li.common-owner")];
    expect(owners[0]?.textContent).toContain("Nancy Pelosi");
    expect(owners[0]?.textContent).toContain("D–CA"); // party chip
    expect(owners[0]?.textContent).toContain("Buys: Jun 20, 2026, May 2, 2026");
    expect(owners[0]?.textContent).toContain("$500K–$1M");
    // Annual-only owner: no fabricated buy dates.
    expect(owners[2]?.textContent).toContain("No disclosed buys");
    // SOLD member: listed, flagged, struck-through range, inactive chip.
    expect(owners[3]?.textContent).toContain("SOLD");
    expect(owners[3]?.textContent).toContain("no longer serving");
    expect(owners[3]?.querySelector(".sold-range")).not.toBeNull();

    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(detail.hidden).toBe(true);
  });

  it("sort select reorders rows", async () => {
    const { view } = await loadedView();
    const sort = view.querySelector<HTMLSelectElement>("select");
    if (!sort) throw new Error("sort select missing");
    sort.value = "latestBuy";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
    expect(tickers(view)).toEqual(["NVDA", "IBIT", "MSTR"]);
    sort.value = "owners";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
    expect(tickers(view)).toEqual(["IBIT", "MSTR", "NVDA"]);
  });

  it("renders an honest empty state", async () => {
    const { view } = await loadedView([]);
    expect(view.textContent).toContain("No security is currently held by two or more members");
    expect(view.querySelector("table")).toBeNull();
  });

  it("renders an error state with a retry that refetches", async () => {
    let calls = 0;
    const common = renderCommonHoldingsView(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("HTTP 404")) : Promise.resolve(rows);
    });
    common.load();
    await flush();
    expect(common.view.textContent).toContain("The common holdings failed to load.");
    expect(common.view.textContent).toContain("HTTP 404");

    common.view.querySelector<HTMLButtonElement>("button.show-more")?.click();
    await flush();
    expect(calls).toBe(2);
    expect(tickers(common.view)).toHaveLength(3);
  });
});
