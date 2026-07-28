// @vitest-environment happy-dom
/**
 * Smoke test over the real fixtures: the numbers in the hero and stat cards
 * are computed from data, epistemics chips show up where the fixtures demand
 * them, and every holding row links its official filing.
 */
import { describe, expect, it } from "vitest";
import { parseDataset } from "../src/data";
import billFx from "./fixtures/bill.json";
import membersFx from "./fixtures/members.json";
import holdingsFx from "./fixtures/holdings.json";
import tradesFx from "./fixtures/trades.json";
import tradersFx from "./fixtures/traders.json";
import newsFx from "./fixtures/news.json";
import metaFx from "./fixtures/meta.json";
import { buildModel } from "../src/derive";
import { renderHero } from "../src/components/hero";
import { renderBillStrip } from "../src/components/billStrip";
import { renderHoldingsView } from "../src/components/holdingsView";
import { renderPortfolioView } from "../src/components/traderCards";

const data = parseDataset({
  bill: billFx,
  members: membersFx,
  holdings: holdingsFx,
  trades: tradesFx,
  traders: tradersFx,
  news: newsFx,
  meta: metaFx,
});
const model = buildModel(data);

describe("model derived from fixtures", () => {
  it("computes the House tally and holder counts from data", () => {
    expect(model.housePassage?.yea).toBe(294);
    expect(model.housePassage?.nay).toBe(134);
    // Distinct members with a current (non-sold) holding; Reschenthaler (sold) excluded.
    expect(model.holderCount).toBe(11);
    expect(model.tier1HoldersByParty.get("R")).toBe(9);
    expect(model.tier1HoldersByParty.get("D")).toBe(2);
  });

  it("sums exposure band-wise and scales the range bars to the largest hi", () => {
    expect(model.combinedExposure.lo).toBeGreaterThan(0);
    expect(model.combinedExposure.hi).toBeGreaterThan(model.combinedExposure.lo);
    expect(model.tier1MaxHi).toBe(2_600_000);
  });

  it("ranks traders by disclosed trade count", () => {
    const counts = model.rankedTraders.map((r) => r.trader.tradeCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(model.rankedTraders[0]?.member?.name).toBe("Gil Cisneros");
  });
});

describe("rendered views", () => {
  it("hero states the vote result and computed holder count", () => {
    const hero = renderHero(model, data.meta);
    expect(hero.textContent).toContain("294–134");
    expect(hero.textContent).toContain("11 members");
  });

  it("bill strip renders stages, the substitute warning, and latest reporting", () => {
    const strip = renderBillStrip(data.bill, data.news, data.meta);
    expect(strip.querySelectorAll(".stage")).toHaveLength(data.bill.stages.length);
    expect(strip.querySelectorAll(".stage.current")).toHaveLength(1);
    expect(strip.querySelector(".subnote")?.textContent).toContain("A cloture vote is not a passage vote");
    expect(strip.querySelectorAll(".news-item")).toHaveLength(data.news.length);
  });

  it("holdings view carries the epistemics chips the fixtures demand", () => {
    const view = renderHoldingsView(model);
    const text = view.textContent ?? "";
    expect(text).toContain("SOLD Apr 2025"); // Reschenthaler exit
    expect(text).toContain("OCR"); // Begich scanned annual FD
    expect(text).toContain("unverified");
    expect(text).toContain("spouse");
    expect(text).toContain("no floor vote yet"); // senators, pre floor vote
  });

  it("links every Tier 1 range to an official filing URL", () => {
    const view = renderHoldingsView(model);
    const links = [...view.querySelectorAll<HTMLAnchorElement>("a.range-link")];
    expect(links.length).toBeGreaterThan(0);
    const filingHosts = ["disclosures-clerk.house.gov", "efdsearch.senate.gov"];
    for (const link of links) {
      expect(filingHosts.some((host) => link.href.includes(host))).toBe(true);
    }
  });

  it("portfolio view quotes claims and colors measured returns by sign", () => {
    const view = renderPortfolioView(model, data.meta);
    expect(view.querySelectorAll(".trader")).toHaveLength(data.traders.length);
    expect(view.querySelectorAll(".measured-value.loss").length).toBeGreaterThan(0); // McCormick −23.2%
    expect(view.querySelectorAll(".measured-value.gain").length).toBeGreaterThan(0);
    expect(view.textContent).toContain("−23.2%");
    // Claims are quoted, with a source link.
    const claimLinks = view.querySelectorAll("a.claim-source");
    expect(claimLinks.length).toBeGreaterThan(0);
  });

  it("renders the reputation chip only when claimsSupported === false", () => {
    const CHIP = "reputation not supported by filings";
    // Fixture traders omit the field -> the chip must not render.
    const plain = renderPortfolioView(model, data.meta);
    expect(plain.textContent).not.toContain(CHIP);

    // A trader whose numeric claims the filings contradict gets the chip.
    const busted = buildModel({
      ...data,
      traders: data.traders.map((t, i) => (i === 0 ? { ...t, claimsSupported: false } : t)),
    });
    const view = renderPortfolioView(busted, data.meta);
    const chips = [...view.querySelectorAll(".chip.conflict")].filter(
      (c) => c.textContent === CHIP,
    );
    expect(chips).toHaveLength(1);

    // claimsSupported true renders nothing either - the chip only flags.
    const supported = buildModel({
      ...data,
      traders: data.traders.map((t) => ({ ...t, claimsSupported: true })),
    });
    expect(renderPortfolioView(supported, data.meta).textContent).not.toContain(CHIP);
  });
});
