import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HouseIngestError,
  classifyDocId,
  clerkDateToIso,
  downloadHouseIndex,
  parseHouseIndexXml,
  parseHouseIndexZip,
} from "../../src/house/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "house");
const indexZip = new Uint8Array(readFileSync(join(fixturesDir, "2026FD.zip")));

describe("parseHouseIndexZip (live 2026FD.zip snapshot)", () => {
  const filings = parseHouseIndexZip(indexZip, 2026);

  it("parses every filing row", () => {
    expect(filings.length).toBe(1433);
  });

  it("finds the verified 2026 PTR split: 318 total, 285 e-filed, 33 paper", () => {
    const ptrs = filings.filter((f) => f.filingType === "P");
    expect(ptrs.length).toBe(318);
    const channels = ptrs.map((f) => classifyDocId(f.docId));
    expect(channels.filter((c) => c === "electronic").length).toBe(285);
    expect(channels.filter((c) => c === "paper").length).toBe(33);
    expect(channels.filter((c) => c === "unknown").length).toBe(0);
  });

  it("parses a known e-filed PTR row (Biggs, SC03)", () => {
    const row = filings.find((f) => f.docId === "20034195");
    expect(row).toEqual({
      prefix: "Hon.",
      last: "Biggs",
      first: "Sheri",
      suffix: "",
      filingType: "P",
      stateDst: "SC03",
      year: 2026,
      filedDate: "2026-03-21",
      docId: "20034195",
    });
  });

  it("parses a known paper PTR row (Fleischmann, TN03)", () => {
    const row = filings.find((f) => f.docId === "8221321");
    expect(row?.filingType).toBe("P");
    expect(row?.last).toBe("Fleischmann");
    expect(row?.filedDate).toBe("2026-02-09");
    expect(classifyDocId(row!.docId)).toBe("paper");
  });

  it("rejects a zip without the expected XML entry", () => {
    expect(() => parseHouseIndexZip(indexZip, 2020)).toThrowError(HouseIngestError);
    try {
      parseHouseIndexZip(indexZip, 2020);
    } catch (err) {
      expect((err as HouseIngestError).code).toBe("index-missing-entry");
    }
  });

  it("rejects bytes that are not a zip", () => {
    expect(() => parseHouseIndexZip(new Uint8Array([1, 2, 3]), 2026)).toThrowError(
      HouseIngestError,
    );
  });
});

describe("parseHouseIndexXml", () => {
  it("handles self-closing empty tags and XML entities", () => {
    const xml = `<FinancialDisclosure><Member>
      <Prefix />
      <Last>O&apos;Halleran &amp; Sons</Last>
      <First>Tom</First>
      <Suffix />
      <FilingType>P</FilingType>
      <StateDst>AZ01</StateDst>
      <Year>2026</Year>
      <FilingDate>1/5/2026</FilingDate>
      <DocID>20030001</DocID>
    </Member></FinancialDisclosure>`;
    const [row] = parseHouseIndexXml(xml);
    expect(row?.prefix).toBe("");
    expect(row?.last).toBe("O'Halleran & Sons");
    expect(row?.filedDate).toBe("2026-01-05");
  });

  it("throws index-parse when no rows are present", () => {
    try {
      parseHouseIndexXml("<FinancialDisclosure></FinancialDisclosure>");
      expect.unreachable();
    } catch (err) {
      expect((err as HouseIngestError).code).toBe("index-parse");
    }
  });
});

describe("clerkDateToIso", () => {
  it("pads month and day", () => {
    expect(clerkDateToIso("3/31/2026")).toBe("2026-03-31");
    expect(clerkDateToIso("11/2/2025")).toBe("2025-11-02");
  });

  it("throws on garbage", () => {
    expect(() => clerkDateToIso("2026-03-31")).toThrowError(HouseIngestError);
  });
});

describe("downloadHouseIndex", () => {
  it("wraps network failure in a typed index-download error", async () => {
    const failingFetch = (() => Promise.reject(new Error("ECONNRESET"))) as typeof fetch;
    await expect(downloadHouseIndex(2026, failingFetch)).rejects.toMatchObject({
      name: "HouseIngestError",
      code: "index-download",
    });
  });

  it("wraps HTTP error statuses", async () => {
    const notFoundFetch = (() =>
      Promise.resolve(new Response("nope", { status: 404 }))) as typeof fetch;
    await expect(downloadHouseIndex(2026, notFoundFetch)).rejects.toMatchObject({
      code: "index-download",
    });
  });

  it("parses a served fixture zip", async () => {
    const servingFetch = (() =>
      Promise.resolve(
        new Response(indexZip.slice().buffer as ArrayBuffer, { status: 200 }),
      )) as typeof fetch;
    const filings = await downloadHouseIndex(2026, servingFetch);
    expect(filings.length).toBe(1433);
  });
});
