import { describe, expect, it } from "vitest";
import type { Trade } from "@clarity-btc/shared";
import { crossCheckKadoa, selectRosterFilerIds } from "../../src/kadoa/index.js";
import { fixtureFetchFn, loadFilersFixture, loadMembers, loadUniverse } from "./helpers.js";

const members = loadMembers();
const universe = loadUniverse();

/** As if the official House ingest had already extracted Gill's 2025-06-20 buy. */
const officialGillBuy: Trade = {
  memberId: "G000603",
  assetRaw: "BTC",
  security: { ticker: "BTC", kind: "direct" },
  side: "buy",
  range: { lo: 500001, hi: 1000000 },
  transactionDate: "2025-06-20",
  filedDate: "2025-07-10",
  docUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030641.pdf",
  late: false,
};

describe("selectRosterFilerIds", () => {
  it("selects exactly the kadoa filers matching the roster (phantoms excluded)", () => {
    const ids = selectRosterFilerIds(loadFilersFixture(), members);
    expect(ids).toContain("house_brandon_gill");
    expect(ids).toContain("senate_davidh_mccormick");
    expect(ids).toContain("house_felixbarry_moore");
    expect(ids).toContain("house_samt_liccardo"); // on the full-Congress roster
    expect(ids).not.toContain("senate_alan_armstrong"); // phantom, no party
    expect(ids).not.toContain("oge_donald_trump"); // executive
  });
});

describe("crossCheckKadoa (end-to-end over fixtures, no network)", () => {
  it("backfills history, flags misses, and stamps provenance", async () => {
    const calls: string[] = [];
    const result = await crossCheckKadoa([officialGillBuy], {
      members,
      universe,
      officialCoverageStart: "2026-07-01",
      fetch: { cacheDir: null, fetchFn: fixtureFetchFn(calls) },
    });

    // Fetched the two core datasets plus per-filer histories, never twice.
    expect(calls.some((u) => u.endsWith("/trades.json"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/filers.json"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/filer/house_brandon_gill.json"))).toBe(true);

    expect(result.normalized).toBeGreaterThan(50);
    expect(result.merged.length).toBeGreaterThan(50);
    expect(result.merged.every((t) => ["official", "kadoa", "both"].includes(t.provenance))).toBe(
      true,
    );

    // The official Gill row matched its kadoa counterpart -> "both", kept as-is.
    const gill = result.merged.filter(
      (t) =>
        t.memberId === "G000603" &&
        t.transactionDate === "2025-06-20" &&
        t.security?.kind === "direct",
    );
    expect(gill).toHaveLength(1);
    expect(gill[0]?.provenance).toBe("both");
    expect(gill[0]?.docUrl).toBe(officialGillBuy.docUrl);

    // Historical BTC rows arrive as kadoa backfill (filed before coverage).
    const backfilledGill = result.backfilled.filter((t) => t.memberId === "G000603");
    expect(backfilledGill.length).toBeGreaterThan(5);
    expect(backfilledGill.some((t) => t.security?.kind === "direct")).toBe(true);
    expect(backfilledGill.some((t) => t.security?.ticker === "IBIT")).toBe(true);

    // McCormick's BITB history lands too.
    const bitb = result.merged.filter((t) => t.security?.ticker === "BITB");
    expect(bitb.length).toBeGreaterThanOrEqual(5);
    expect(bitb.every((t) => t.memberId === "M001243")).toBe(true);

    // Rows filed on/after coverage start that we did not ingest -> missed.
    expect(result.missedByOfficial.length).toBeGreaterThan(0);
    expect(result.missedByOfficial.every((t) => t.filedDate >= "2026-07-01")).toBe(true);
    expect(result.missedByOfficial.every((t) => t.provenance === "kadoa")).toBe(true);

    // With the full-Congress roster every partied fixture filer resolves;
    // phantom (party-less) filers are skipped as phantoms, not unmatched.
    expect(result.unmatchedFilers).toEqual([]);

    // Executive rows were skipped, never merged.
    expect(result.skipped.some((s) => s.reason === "non-congress filer")).toBe(true);
  });

  it("records conflicts when the official row disagrees with kadoa", async () => {
    const wrongRange: Trade = { ...officialGillBuy, range: { lo: 250001, hi: 500000 } };
    const result = await crossCheckKadoa([wrongRange], {
      members,
      universe,
      fetch: { cacheDir: null, fetchFn: fixtureFetchFn() },
    });
    const conflict = result.conflicts.find(
      (c) => c.official.memberId === "G000603" && c.official.transactionDate === "2025-06-20",
    );
    expect(conflict).toBeDefined();
    expect(conflict?.fields).toContain("range.lo");
    // Official values kept in the merged output.
    const merged = result.merged.find(
      (t) => t.memberId === "G000603" && t.transactionDate === "2025-06-20",
    );
    expect(merged).toMatchObject({ provenance: "both", range: { lo: 250001, hi: 500000 } });
  });
});
