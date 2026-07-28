import { describe, expect, it } from "vitest";
import type { Member } from "@clarity-btc/shared";
import type { KadoaTradeRow } from "../../src/kadoa/index.js";
import { buildKadoaReturnLookup } from "../../src/returns/index.js";
import { loadFilerFileFixture } from "../kadoa/helpers.js";
import { makeTrade } from "./helpers.js";

const mccormick: Member = {
  bioguideId: "M001243",
  name: "Dave McCormick",
  party: "R",
  chamber: "senate",
  state: "PA",
  active: true,
};

function row(overrides: Partial<KadoaTradeRow> & { id: string }): KadoaTradeRow {
  return {
    filer_name: "David H McCormick",
    chamber: "senate",
    branch: "congress",
    party: "R",
    transaction_date: "2025-11-28",
    transaction_type: "Purchase",
    amount_range_low: 50001,
    amount_range_high: 100000,
    ...overrides,
  };
}

describe("buildKadoaReturnLookup", () => {
  it("matches a merged trade to the kadoa row's precomputed returns", () => {
    const file = loadFilerFileFixture("senate_davidh_mccormick");
    const lookup = buildKadoaReturnLookup(file.trades, [file.filer], [mccormick]);

    // Fixture row: 2025-11-28 BITB Purchase $50,001-$100,000 (per-filer rows
    // carry only filer_id - the filer directory supplies the name to match).
    const hit = lookup.find(
      makeTrade({
        memberId: "M001243",
        assetRaw: "Bitwise Bitcoin ETF",
        transactionDate: "2025-11-28",
        range: { lo: 50001, hi: 100000 },
      }),
    );
    expect(hit?.ticker).toBe("BITB");
    expect(hit?.retSince).toBeCloseTo(-28.62915619855051, 9);
    expect(hit?.excessSince).toBeCloseTo(-36.48849856326599, 9);
  });

  it("loose-matches when the official filing words the asset differently", () => {
    const file = loadFilerFileFixture("senate_davidh_mccormick");
    const lookup = buildKadoaReturnLookup(file.trades, [file.filer], [mccormick]);
    const hit = lookup.find(
      makeTrade({
        memberId: "M001243",
        assetRaw: "Bitwise Bitcoin ETF Trust - Common Shares", // not kadoa's text
        transactionDate: "2025-11-28",
        range: { lo: 50001, hi: 100000 },
      }),
    );
    expect(hit?.ticker).toBe("BITB");
    expect(hit?.retSince).toBeCloseTo(-28.62915619855051, 9);
  });

  it("keeps agreeing same-day duplicate rows but refuses ambiguous ones", () => {
    const agreeing = buildKadoaReturnLookup(
      [
        row({ id: "a", ticker: "BITB", asset_name: "Bitwise Bitcoin ETF", ret_since: -28.6 }),
        row({ id: "b", ticker: "BITB", asset_name: "Bitwise Bitcoin ETF", ret_since: -28.6 }),
      ],
      [],
      [mccormick],
    );
    expect(
      agreeing.find(
        makeTrade({
          memberId: "M001243",
          assetRaw: "some other wording",
          transactionDate: "2025-11-28",
          range: { lo: 50001, hi: 100000 },
        }),
      )?.ticker,
    ).toBe("BITB");

    const ambiguous = buildKadoaReturnLookup(
      [
        row({ id: "a", ticker: "BITB", asset_name: "Bitwise Bitcoin ETF", ret_since: -28.6 }),
        row({ id: "b", ticker: "IBIT", asset_name: "iShares Bitcoin Trust", ret_since: 4.2 }),
      ],
      [],
      [mccormick],
    );
    // Loose key collides with disagreeing values -> refuse to guess...
    expect(
      ambiguous.find(
        makeTrade({
          memberId: "M001243",
          assetRaw: "some other wording",
          transactionDate: "2025-11-28",
          range: { lo: 50001, hi: 100000 },
        }),
      ),
    ).toBeUndefined();
    // ...but exact asset text still resolves each row.
    expect(
      ambiguous.find(
        makeTrade({
          memberId: "M001243",
          assetRaw: "iShares Bitcoin Trust",
          transactionDate: "2025-11-28",
          range: { lo: 50001, hi: 100000 },
        }),
      )?.ticker,
    ).toBe("IBIT");
  });

  it("ignores rows for filers that don't resolve to the roster", () => {
    const lookup = buildKadoaReturnLookup(
      [row({ id: "a", ticker: "TSLA", filer_name: "Alan Armstrong", ret_since: 1 })],
      [],
      [mccormick],
    );
    expect(
      lookup.find(
        makeTrade({
          memberId: "M001243",
          assetRaw: "TSLA",
          transactionDate: "2025-11-28",
          range: { lo: 50001, hi: 100000 },
        }),
      ),
    ).toBeUndefined();
  });
});
