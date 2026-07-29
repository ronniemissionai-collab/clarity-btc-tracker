// @vitest-environment happy-dom
/**
 * Member portfolio view: header chips, measured-return estimate labelling,
 * positions table with owner/epistemics chips and filing links on every row,
 * the windowed trades timeline, and honest loading / error / empty states.
 */
import { describe, expect, it } from "vitest";
import type { Trade } from "@clarity-btc/shared";
import {
  renderMemberDetail,
  renderMemberPage,
  TRADE_PAGE_SIZE,
} from "../src/components/memberDetail";
import { parsePortfolio, type MemberPortfolio } from "../src/portfolioData";
import pelosiFx from "./fixtures/portfolio/P000197.json";
import lummisFx from "./fixtures/portfolio/L000571.json";

const pelosi = parsePortfolio(pelosiFx, "P000197");
const lummis = parsePortfolio(lummisFx, "L000571");

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("portfolio contract parsing", () => {
  it("accepts the fixtures and enforces the member id", () => {
    expect(pelosi.member.name).toBe("Nancy Pelosi");
    expect(pelosi.positions).toHaveLength(3);
    expect(pelosi.trades).toHaveLength(3);
    expect(() => parsePortfolio(pelosiFx, "L000571")).toThrow(/expected L000571/);
    expect(() => parsePortfolio({ member: pelosiFx.member }, "P000197")).toThrow();
  });
});

describe("member detail render", () => {
  const detail = renderMemberDetail(pelosi);

  it("renders the member header with party/chamber chips and roster flag", () => {
    expect(detail.querySelector("h1")?.textContent).toBe("Nancy Pelosi");
    const chipTexts = [...detail.querySelectorAll(".member-chips .chip")].map((c) => c.textContent);
    expect(chipTexts).toContain("D–CA");
    expect(chipTexts).toContain("House");
    expect(chipTexts).toContain("tracked");
    expect(chipTexts).not.toContain("no longer serving");
    // The series field feeds a real sparkline.
    expect(detail.querySelector("svg.spark")).not.toBeNull();
  });

  it("flags departed members", () => {
    const departed = renderMemberDetail({
      ...lummis,
      member: { ...lummis.member, active: false },
    });
    expect(departed.textContent).toContain("no longer serving");
  });

  it("shows the measured return as an estimate vs SPY", () => {
    const measured = detail.querySelector(".measured-panel");
    expect(measured?.textContent).toContain("+41.2%");
    expect(measured?.textContent).toContain("+25.1 pp vs SPY");
    expect(measured?.textContent).toContain("estimate");
    expect(measured?.querySelector(".measured-value.gain")).not.toBeNull();
  });

  it("renders the positions table with owner chips, epistemics chips, and a filing link per row", () => {
    const rows = [...detail.querySelectorAll(".positions-table tbody tr")];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const filing = row.querySelector<HTMLAnchorElement>("a[href]");
      expect(filing?.href).toContain("disclosures-clerk.house.gov");
      expect(row.textContent).toContain("spouse"); // owner column chip
    }
    const text = detail.textContent ?? "";
    expect(text).toContain("OCR");
    expect(text).toContain("unverified");
    expect(text).toContain("stale · May 2025");
    expect(text).toContain("SOLD Jan 2026");
  });

  it("renders the trades timeline newest first with side/late chips and filing links", () => {
    const rows = [...detail.querySelectorAll(".trades-table tbody tr")];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Jun 20, 2026");
    expect(rows[0]?.textContent).toContain("BUY");
    expect(rows[1]?.textContent).toContain("SELL");
    expect(rows[1]?.textContent).toContain("late filing");
    for (const row of rows) {
      expect(row.querySelector<HTMLAnchorElement>("a[href]")?.href).toMatch(
        /disclosures-clerk\.house\.gov/,
      );
    }
  });

  it("shows honest empty states for no positions / measured null", () => {
    const empty = renderMemberDetail(lummis);
    expect(empty.textContent).toContain("No disclosed positions derivable from this member's filings.");
    expect(empty.textContent).toContain("Not yet measured");
    expect(empty.textContent).not.toContain("estimate");
  });
});

describe("trades timeline windowing", () => {
  function bigPortfolio(count: number): MemberPortfolio {
    const template = lummis.trades[0];
    if (!template) throw new Error("fixture trade missing");
    const trades: Trade[] = Array.from({ length: count }, (_, i) => ({
      ...template,
      assetRaw: `Asset lot ${i}`,
      transactionDate: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    }));
    return { ...lummis, trades };
  }

  it("renders 50 rows at a time and appends on Show more until exhausted", () => {
    const detail = renderMemberDetail(bigPortfolio(120));
    const rows = (): number => detail.querySelectorAll(".trades-table tbody tr").length;
    expect(TRADE_PAGE_SIZE).toBe(50);
    expect(rows()).toBe(50);

    const more = detail.querySelector<HTMLButtonElement>("button.show-more");
    if (!more) throw new Error("show-more button missing");
    expect(more.textContent).toContain("70 remaining");

    more.click();
    expect(rows()).toBe(100);
    expect(more.textContent).toContain("20 remaining");

    more.click();
    expect(rows()).toBe(120);
    expect(detail.querySelector("button.show-more")).toBeNull();
  });

  it("renders no Show more button when the history fits one window", () => {
    const detail = renderMemberDetail(pelosi);
    expect(detail.querySelector("button.show-more")).toBeNull();
  });
});

describe("member page shell", () => {
  it("shows a loading state then the fetched detail", async () => {
    const page = renderMemberPage("P000197", () => Promise.resolve(pelosi));
    expect(page.textContent).toContain("Loading portfolio P000197…");
    await flush();
    expect(page.querySelector("h1")?.textContent).toBe("Nancy Pelosi");
  });

  it("shows an honest error state when the fetch fails", async () => {
    const page = renderMemberPage("P000197", () =>
      Promise.reject(new Error("fetch /data/portfolio/P000197.json: HTTP 404")),
    );
    await flush();
    expect(page.textContent).toContain("The portfolio for P000197 failed to load.");
    expect(page.textContent).toContain("HTTP 404");
  });
});
