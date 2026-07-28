// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { Holding } from "@clarity-btc/shared";
import { holdingFlagChips, partyChip, voteChip } from "../src/components/flags";

function holding(overrides: Partial<Holding> = {}): Holding {
  return {
    memberId: "G000602",
    security: { ticker: "BTC", kind: "direct" },
    owner: "self",
    range: { lo: 1001, hi: 15000 },
    status: "holds",
    asOf: "2025-04-24",
    extraction: "pdf-text",
    verification: "corroborated",
    sources: [
      {
        kind: "filing",
        url: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026591.pdf",
      },
    ],
    ...overrides,
  };
}

const texts = (chips: HTMLElement[]): string[] => chips.map((c) => c.textContent ?? "");

describe("holdingFlagChips", () => {
  it("renders no chips for a clean self-owned corroborated current holding", () => {
    expect(holdingFlagChips(holding())).toHaveLength(0);
  });

  it("flags non-self owners with an owner chip", () => {
    for (const owner of ["spouse", "dependent", "joint", "trust"] as const) {
      const chips = holdingFlagChips(holding({ owner }));
      expect(texts(chips)).toContain(owner);
      expect(chips[0]?.classList.contains("owner")).toBe(true);
    }
  });

  it("flags OCR-extracted rows", () => {
    const chips = holdingFlagChips(holding({ extraction: "pdf-ocr" }));
    expect(texts(chips)).toContain("OCR");
  });

  it("flags unverified rows", () => {
    const chips = holdingFlagChips(holding({ verification: "unverified" }));
    expect(texts(chips)).toContain("unverified");
    expect(chips[0]?.classList.contains("unverified")).toBe(true);
  });

  it("renders a SOLD chip with the filing month", () => {
    const chips = holdingFlagChips(holding({ status: "sold", asOf: "2025-04-24" }));
    expect(texts(chips)).toContain("SOLD Apr 2025");
    expect(chips[0]?.classList.contains("sold")).toBe(true);
  });

  it("stacks every applicable flag on one row", () => {
    const chips = holdingFlagChips(
      holding({ owner: "spouse", extraction: "pdf-ocr", verification: "unverified", status: "stale" }),
    );
    expect(texts(chips)).toEqual(["spouse", "OCR", "unverified", "stale · Apr 2025"]);
  });
});

describe("voteChip", () => {
  it("renders recorded House votes with the yea/nay color classes", () => {
    const yea = voteChip({ kind: "recorded", vote: "yea" });
    expect(yea.textContent).toBe("Yea");
    expect(yea.classList.contains("yea")).toBe(true);
    const nay = voteChip({ kind: "recorded", vote: "nay" });
    expect(nay.textContent).toBe("Nay");
    expect(nay.classList.contains("nay")).toBe(true);
  });

  it("never renders a senator as having voted before a floor vote exists", () => {
    const pending = voteChip({ kind: "senate-pending" });
    expect(pending.textContent).toBe("no floor vote yet");
    expect(pending.classList.contains("yea")).toBe(false);
    expect(pending.classList.contains("nay")).toBe(false);
  });

  it("marks missing roll-call data as missing, not as a vote", () => {
    expect(voteChip({ kind: "unrecorded" }).textContent).toBe("no roll-call data");
  });
});

describe("partyChip", () => {
  it("renders party–state with the party color class", () => {
    const chip = partyChip({ party: "R", state: "TX" });
    expect(chip.textContent).toBe("R–TX");
    expect(chip.classList.contains("r")).toBe(true);
  });
});
