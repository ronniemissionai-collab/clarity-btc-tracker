/**
 * Validates the config files and data fixtures against the shared contract,
 * including the contested-case pins the validation gate must enforce.
 */
import { describe, expect, it } from "vitest";
import {
  parseBill,
  parseExpectations,
  parseHoldings,
  parseMembers,
  parseMeta,
  parseNews,
  parseTraders,
  parseTradersConfig,
  parseTrades,
  parseUniverseConfig,
  securityKey,
} from "../src/index.js";

import universeRaw from "../../../config/universe.json";
import tradersConfigRaw from "../../../config/traders.json";
import expectationsRaw from "../../../config/expectations.json";
import billRaw from "../../../site/test/fixtures/bill.json";
import membersRaw from "../../../site/test/fixtures/members.json";
import holdingsRaw from "../../../site/test/fixtures/holdings.json";
import tradesRaw from "../../../site/test/fixtures/trades.json";
import tradersRaw from "../../../site/test/fixtures/traders.json";
import newsRaw from "../../../site/test/fixtures/news.json";
import metaRaw from "../../../site/test/fixtures/meta.json";

describe("config/universe.json", () => {
  const universe = parseUniverseConfig(universeRaw).universe;

  it("parses and has exactly 36 entries", () => {
    expect(universe).toHaveLength(36);
  });

  it("has unique ticker+kind keys (the two 'BTC' entries differ by kind)", () => {
    const keys = universe.map(securityKey);
    expect(new Set(keys).size).toBe(36);
    expect(keys).toContain("BTC:direct");
    expect(keys).toContain("BTC:spot-etf");
  });

  it("splits into 23 Tier 1 and 13 Tier 2 securities", () => {
    expect(universe.filter((s) => s.tier === 1)).toHaveLength(23);
    expect(universe.filter((s) => s.tier === 2)).toHaveLength(13);
  });
});

describe("config/traders.json", () => {
  const roster = parseTradersConfig(tradersConfigRaw);

  it("loads with a 15-member active core", () => {
    expect(roster.active).toHaveLength(15);
  });

  it("every active entry carries at least one sourced claim", () => {
    for (const entry of roster.active) {
      expect(entry.claims.length).toBeGreaterThan(0);
    }
  });

  it("has a non-empty watch shelf that includes the departed MTG", () => {
    expect(roster.watch.length).toBeGreaterThan(0);
    const mtg = roster.watch.find((w) => w.id === "G000596");
    expect(mtg?.status).toBe("departed");
    expect(roster.active.some((a) => a.id === "G000596")).toBe(false);
  });
});

describe("config/expectations.json", () => {
  const expectations = parseExpectations(expectationsRaw);

  it("pins the holder bound at 9-25 (recalibrated after the first live run)", () => {
    // min was lowered from the research estimate of 15: the justification and
    // the named invisible holders live in config/expectations.json
    // (holderBoundNote / invisibleKnownHolders).
    expect(expectations.holderBound).toEqual({ min: 9, max: 25 });
  });

  it("carries the four contested-case pins", () => {
    const ids = expectations.contested.map((c) => c.id);
    expect(ids).toEqual([
      "mccormick-instrument",
      "gill-direct-btc-range",
      "lummis-blind-trust",
      "mtg-absent",
    ]);
  });
});

describe("data fixtures parse against the schemas", () => {
  it("members.json", () => {
    expect(parseMembers(membersRaw).length).toBeGreaterThan(0);
  });
  it("holdings.json", () => {
    expect(parseHoldings(holdingsRaw).length).toBeGreaterThan(0);
  });
  it("trades.json", () => {
    expect(parseTrades(tradesRaw).length).toBeGreaterThan(0);
  });
  it("bill.json", () => {
    const bill = parseBill(billRaw);
    expect(bill.number).toBe(3633);
    expect(bill.congress).toBe(119);
  });
  it("traders.json", () => {
    expect(parseTraders(tradersRaw).length).toBeGreaterThan(0);
  });
  it("news.json", () => {
    expect(parseNews(newsRaw).length).toBeGreaterThan(0);
  });
  it("meta.json", () => {
    expect(parseMeta(metaRaw).run.ok).toBe(true);
  });
});

describe("fixture referential integrity", () => {
  const members = parseMembers(membersRaw);
  const memberIds = new Set(members.map((m) => m.bioguideId));
  const holdings = parseHoldings(holdingsRaw);
  const trades = parseTrades(tradesRaw);
  const traders = parseTraders(tradersRaw);
  const universe = parseUniverseConfig(universeRaw).universe;
  const universeKeys = new Set(universe.map(securityKey));

  it("every holding, trade, and trader row references a known member", () => {
    for (const h of holdings) expect(memberIds).toContain(h.memberId);
    for (const t of trades) expect(memberIds).toContain(t.memberId);
    for (const t of traders) expect(memberIds).toContain(t.memberId);
  });

  it("every holding references a security in the universe config", () => {
    for (const h of holdings) {
      expect(universeKeys).toContain(securityKey(h.security));
    }
  });

  it("every resolved trade security is in the universe config", () => {
    for (const t of trades) {
      if (t.security !== null) {
        expect(universeKeys).toContain(securityKey(t.security));
      }
    }
  });
});

describe("contested-case pins hold against the fixtures", () => {
  const holdings = parseHoldings(holdingsRaw);
  const members = parseMembers(membersRaw);

  it("McCormick holds BITB (spot-etf), never direct BTC", () => {
    const rows = holdings.filter((h) => h.memberId === "M001243");
    expect(rows.some((h) => securityKey(h.security) === "BITB:spot-etf")).toBe(true);
    expect(rows.some((h) => securityKey(h.security) === "BTC:direct")).toBe(false);
  });

  it("Gill's direct BTC range sits within $1.15M-$2.6M", () => {
    const row = holdings.find(
      (h) => h.memberId === "G000603" && securityKey(h.security) === "BTC:direct",
    );
    expect(row).toBeDefined();
    expect(row!.range.lo).toBeGreaterThanOrEqual(1150000);
    expect(row!.range.hi).toBeLessThanOrEqual(2600000);
  });

  it("Lummis's direct BTC carries owner 'self' per her 2021 PTR (blind trust is press-level only)", () => {
    const row = holdings.find(
      (h) => h.memberId === "L000571" && securityKey(h.security) === "BTC:direct",
    );
    expect(row?.owner).toBe("self");
  });

  it("MTG is inactive (resigned) and holds nothing in the fixture", () => {
    const mtg = members.find((m) => m.bioguideId === "G000596");
    expect(mtg?.active).toBe(false);
    expect(holdings.some((h) => h.memberId === "G000596")).toBe(false);
  });
});
