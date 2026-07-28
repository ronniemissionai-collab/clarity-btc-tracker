import { describe, expect, it } from "vitest";
import type { Trade } from "@clarity-btc/shared";
import { mergeTrades } from "../../src/kadoa/index.js";

/** Gill's 2025-06-20 direct-BTC buy as our official ingest would emit it. */
function officialGillBuy(overrides: Partial<Trade> = {}): Trade {
  return {
    memberId: "G000602",
    assetRaw: "BTC",
    security: { ticker: "BTC", kind: "direct" },
    side: "buy",
    range: { lo: 500001, hi: 1000000 },
    transactionDate: "2025-06-20",
    filedDate: "2025-07-10",
    docUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030641.pdf",
    late: false,
    ...overrides,
  };
}

/** The same trade as kadoa reports it. */
function kadoaGillBuy(overrides: Partial<Trade> = {}): Trade {
  return officialGillBuy({
    note: "via kadoa",
    ...overrides,
  });
}

function mccormickBitb(overrides: Partial<Trade> = {}): Trade {
  return {
    memberId: "M001244",
    assetRaw: "Bitwise Bitcoin ETF",
    security: { ticker: "BITB", kind: "spot-etf" },
    side: "buy",
    owner: "self",
    range: { lo: 50001, hi: 100000 },
    transactionDate: "2025-11-28",
    filedDate: "2025-12-26",
    docUrl: "https://efdsearch.senate.gov/search/view/ptr/e337e1b4-ff0a-4b83-8a58-1d25a81ea26f/",
    late: false,
    ...overrides,
  };
}

describe("mergeTrades", () => {
  it("stamps provenance on every merged row", () => {
    const { merged } = mergeTrades([officialGillBuy()], [mccormickBitb()]);
    expect(merged).toHaveLength(2);
    expect(merged.every((t) => ["official", "kadoa", "both"].includes(t.provenance))).toBe(true);
  });

  it("marks matched rows 'both' and keeps the official row", () => {
    const official = officialGillBuy();
    const { merged, conflicts, backfilled, missedByOfficial } = mergeTrades(
      [official],
      [kadoaGillBuy()],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.provenance).toBe("both");
    expect(merged[0]?.note).toBeUndefined(); // official row kept, kadoa's note not merged in
    expect(conflicts).toEqual([]);
    expect(backfilled).toEqual([]);
    expect(missedByOfficial).toEqual([]);
  });

  it("official wins on conflicting details, and the conflict is recorded", () => {
    const official = officialGillBuy();
    const kadoa = kadoaGillBuy({ range: { lo: 250001, hi: 500000 }, late: true });
    const { merged, conflicts } = mergeTrades([official], [kadoa]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      provenance: "both",
      range: { lo: 500001, hi: 1000000 },
      late: false,
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.fields.sort()).toEqual(["late", "range.hi", "range.lo"]);
    expect(conflicts[0]?.official.range).toEqual({ lo: 500001, hi: 1000000 });
    expect(conflicts[0]?.kadoa.range).toEqual({ lo: 250001, hi: 500000 });
  });

  it("matches on member+security+date+side even when doc URLs differ", () => {
    // Official Senate rows link the eFD page; kadoa might carry a variant URL.
    const official = mccormickBitb();
    const kadoa = mccormickBitb({
      docUrl: "https://efdsearch.senate.gov/search/view/ptr/e337e1b4-ff0a-4b83-8a58-1d25a81ea26f",
    });
    const { merged, conflicts } = mergeTrades([official], [kadoa]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.provenance).toBe("both");
    expect(merged[0]?.docUrl).toBe(official.docUrl);
    expect(conflicts).toEqual([]);
  });

  it("classifies kadoa-only rows filed before official coverage as backfill", () => {
    const { merged, backfilled, missedByOfficial } = mergeTrades(
      [mccormickBitb()], // earliest official filedDate: 2025-12-26
      [kadoaGillBuy()], // filed 2025-07-10, long before our ingest started
    );
    expect(merged).toHaveLength(2);
    expect(backfilled).toHaveLength(1);
    expect(backfilled[0]).toMatchObject({ memberId: "G000602", provenance: "kadoa" });
    expect(missedByOfficial).toEqual([]);
  });

  it("flags kadoa-only rows inside official coverage as missed", () => {
    const missedRow = mccormickBitb({ transactionDate: "2026-01-05", filedDate: "2026-01-20" });
    const { backfilled, missedByOfficial } = mergeTrades([mccormickBitb()], [missedRow]);
    expect(missedByOfficial).toHaveLength(1);
    expect(missedByOfficial[0]).toMatchObject({
      transactionDate: "2026-01-05",
      provenance: "kadoa",
    });
    expect(backfilled).toEqual([]);
  });

  it("honors an explicit officialCoverageStart", () => {
    const row = kadoaGillBuy(); // filed 2025-07-10
    const early = mergeTrades([], [row], { officialCoverageStart: "2025-01-01" });
    expect(early.missedByOfficial).toHaveLength(1);
    expect(early.backfilled).toEqual([]);
    const late = mergeTrades([], [row], { officialCoverageStart: "2026-01-01" });
    expect(late.backfilled).toHaveLength(1);
    expect(late.missedByOfficial).toEqual([]);
  });

  it("with no official rows and no coverage start, everything is backfill", () => {
    const { merged, backfilled } = mergeTrades([], [kadoaGillBuy(), mccormickBitb()]);
    expect(merged).toHaveLength(2);
    expect(backfilled).toHaveLength(2);
    expect(merged.every((t) => t.provenance === "kadoa")).toBe(true);
  });

  it("pairs same-day repeat trades one-to-one", () => {
    // Two identical-range BITB buys on the same day: one official row must
    // absorb exactly one kadoa row; the second kadoa row survives separately.
    const official = [mccormickBitb()];
    const kadoa = [mccormickBitb(), mccormickBitb({ note: "second lot" })];
    const { merged } = mergeTrades(official, kadoa);
    expect(merged).toHaveLength(2);
    expect(merged.filter((t) => t.provenance === "both")).toHaveLength(1);
    expect(merged.filter((t) => t.provenance === "kadoa")).toHaveLength(1);
  });

  it("keys unresolved securities by raw asset text", () => {
    const official = officialGillBuy({ security: null, assetRaw: "St. Denis J. Villere Fund" });
    const matching = officialGillBuy({ security: null, assetRaw: "St Denis J Villere fund" });
    const { merged } = mergeTrades([official], [matching]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.provenance).toBe("both");
  });

  it("sorts merged rows by transaction date, newest first", () => {
    const { merged } = mergeTrades(
      [officialGillBuy()],
      [mccormickBitb(), mccormickBitb({ transactionDate: "2024-03-01", filedDate: "2024-03-10" })],
    );
    const dates = merged.map((t) => t.transactionDate);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});
