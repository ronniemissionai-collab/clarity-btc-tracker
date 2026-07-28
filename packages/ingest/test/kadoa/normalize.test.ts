import { describe, expect, it } from "vitest";
import { isTrade } from "@clarity-btc/shared";
import { normalizeKadoaTrades } from "../../src/kadoa/index.js";
import {
  loadFilerFileFixture,
  loadFilersFixture,
  loadMembers,
  loadTradesFixture,
  loadUniverse,
} from "./helpers.js";

const members = loadMembers();
const universe = loadUniverse();

describe("normalizeKadoaTrades: per-filer fixtures", () => {
  it("normalizes Brandon Gill's direct-BTC and IBIT history", () => {
    const file = loadFilerFileFixture("house_brandon_gill");
    const { trades, skipped } = normalizeKadoaTrades(file.trades, {
      members,
      universe,
      defaultFiler: file.filer,
    });
    expect(trades.length).toBeGreaterThan(0);
    expect(skipped).toEqual([]);
    expect(trades.every(isTrade)).toBe(true);
    expect(trades.every((t) => t.memberId === "G000603")).toBe(true);

    const direct = trades.filter((t) => t.security?.kind === "direct");
    expect(direct.length).toBeGreaterThanOrEqual(4);
    expect(direct.every((t) => t.security?.ticker === "BTC")).toBe(true);
    // The 2025-06-20 buy: $500,001-$1,000,000, filed 2025-07-10, Clerk PDF.
    const bigBuy = direct.find((t) => t.transactionDate === "2025-06-20");
    expect(bigBuy).toMatchObject({
      side: "buy",
      range: { lo: 500001, hi: 1000000 },
      filedDate: "2025-07-10",
      docUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030641.pdf",
      late: false,
    });

    const ibit = trades.filter((t) => t.security?.ticker === "IBIT");
    expect(ibit.length).toBeGreaterThanOrEqual(2);
    expect(ibit.every((t) => t.security?.kind === "spot-etf")).toBe(true);
  });

  it("normalizes Dave McCormick's BITB buys with owner mapping", () => {
    const file = loadFilerFileFixture("senate_davidh_mccormick");
    const { trades } = normalizeKadoaTrades(file.trades, {
      members,
      universe,
      defaultFiler: file.filer,
    });
    expect(trades.every((t) => t.memberId === "M001243")).toBe(true);

    const bitb = trades.filter((t) => t.security?.ticker === "BITB");
    expect(bitb.length).toBeGreaterThanOrEqual(5);
    expect(bitb.every((t) => t.security?.kind === "spot-etf")).toBe(true);
    expect(bitb.every((t) => t.side === "buy")).toBe(true);
    // eFD doc URLs, "Self"/"Spouse" owner strings mapped to the enum.
    expect(bitb.every((t) => t.docUrl.startsWith("https://efdsearch.senate.gov/"))).toBe(true);
    const owners = new Set(trades.map((t) => t.owner));
    expect(owners.has("self")).toBe(true);
    expect(owners.has("spouse")).toBe(true);
  });

  it("normalizes Reschenthaler's direct-BTC sale", () => {
    const file = loadFilerFileFixture("house_guymr_reschenthaler");
    const { trades } = normalizeKadoaTrades(file.trades, {
      members,
      universe,
      defaultFiler: file.filer,
    });
    const sale = trades.find((t) => t.side === "sell" && t.security?.kind === "direct");
    expect(sale).toMatchObject({
      memberId: "R000610",
      assetRaw: "Bitcoin",
      transactionDate: "2025-04-24",
      security: { ticker: "BTC", kind: "direct" },
    });
    // "BTC (Bitcoin)" purchase resolves to direct too.
    const buy = trades.find((t) => t.side === "buy" && t.assetRaw === "BTC (Bitcoin)");
    expect(buy?.security).toEqual({ ticker: "BTC", kind: "direct" });
  });

  it("maps kadoa owner codes (SP) and keeps filing comments as notes", () => {
    const file = loadFilerFileFixture("house_sheri_biggs");
    const { trades } = normalizeKadoaTrades(file.trades, {
      members,
      universe,
      defaultFiler: file.filer,
    });
    const ibit = trades.filter((t) => t.security?.ticker === "IBIT");
    expect(ibit.length).toBe(2);
    expect(ibit.every((t) => t.owner === "spouse")).toBe(true);
    const commented = ibit.find((t) => t.transactionDate === "2026-03-04");
    expect(commented?.note).toBe("Professionally managed account.");
    // The 2025-07-09 buy was filed 2025-10-05 - outside the 45-day window.
    const late = ibit.find((t) => t.transactionDate === "2025-07-09");
    expect(late?.late).toBe(true);
  });
});

describe("normalizeKadoaTrades: top-level trades.json slice", () => {
  const rows = loadTradesFixture();
  const filers = loadFilersFixture();
  const result = normalizeKadoaTrades(rows, { members, universe, filers });

  it("produces schema-valid trades only for rostered congress members", () => {
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades.every(isTrade)).toBe(true);
    const rosterIds = new Set(members.map((m) => m.bioguideId));
    expect(result.trades.every((t) => rosterIds.has(t.memberId))).toBe(true);
  });

  it("drops executive-branch (OGE 278-T) rows", () => {
    const executiveIds = new Set(
      rows.filter((r) => r.branch === "executive").map((r) => r.id),
    );
    expect(executiveIds.size).toBeGreaterThan(0);
    for (const s of result.skipped) {
      if (executiveIds.has(s.id)) expect(s.reason).toBe("non-congress filer");
    }
    const skippedIds = new Set(result.skipped.map((s) => s.id));
    expect([...executiveIds].every((id) => skippedIds.has(id))).toBe(true);
  });

  it("drops phantom filers (congress rows with no party) with a clear reason", () => {
    const phantom = result.skipped.filter((s) => s.reason.startsWith("phantom filer"));
    expect(phantom.length).toBeGreaterThan(0);
    expect(phantom.some((s) => s.reason.includes("Alan Armstrong"))).toBe(true);
  });

  it("reports congress filers that are off the roster instead of guessing", () => {
    // With the full 119th-Congress roster every partied congress filer in the
    // fixture resolves; only names genuinely off the roster may ever land here.
    expect(result.unmatchedFilers).not.toContain("Nancy Pelosi");
    const rosterNames = new Set(members.map((m) => m.name));
    for (const name of result.unmatchedFilers) {
      expect(rosterNames.has(name)).toBe(false);
    }
    expect(result.unmatchedFilers).toEqual([]);
  });

  it("skips unsupported transaction types (Exchange) with a reason", () => {
    const exchanges = rows.filter(
      (r) => r.transaction_type === "Exchange" && r.branch === "congress",
    );
    const bySkipId = new Map(result.skipped.map((s) => [s.id, s.reason]));
    for (const row of exchanges) {
      const reason = bySkipId.get(row.id);
      expect(reason).toBeDefined();
    }
  });

  it("skips rows with a missing amount range", () => {
    const nullAmount = rows.find(
      (r) =>
        (r.amount_range_low == null || r.amount_range_high == null) && r.branch === "congress",
    );
    if (nullAmount !== undefined) {
      const reason = result.skipped.find((s) => s.id === nullAmount.id)?.reason;
      expect(reason).toBeDefined();
    }
  });

  it("resolves the MSTR row (Cisneros) into the universe", () => {
    const mstr = result.trades.filter((t) => t.security?.ticker === "MSTR");
    expect(mstr.length).toBeGreaterThanOrEqual(1);
    expect(mstr[0]).toMatchObject({
      memberId: "C001123",
      security: { ticker: "MSTR", kind: "treasury" },
      side: "buy",
    });
  });

  it("keeps non-universe assets with security: null", () => {
    const unresolved = result.trades.filter((t) => t.security === null);
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.every((t) => t.assetRaw.length > 0)).toBe(true);
  });

  it("skips duplicate row ids", () => {
    const doubled = [...rows, ...rows.slice(0, 3)];
    const rerun = normalizeKadoaTrades(doubled, { members, universe, filers });
    expect(rerun.skipped.filter((s) => s.reason === "duplicate row id").length).toBe(3);
    expect(rerun.trades.length).toBe(result.trades.length);
  });
});
