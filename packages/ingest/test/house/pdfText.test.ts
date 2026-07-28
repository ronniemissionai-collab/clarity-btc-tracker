import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractPdfText,
  hasPdftotext,
  looksScanned,
  parsePtrText,
} from "../../src/house/index.js";
import type { PdfTextEngine } from "../../src/house/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "house");
/** Live-fetched e-filed PTR: Hon. Sheri Biggs (SC03), filed 2026-03-21. */
const textPdf = new Uint8Array(readFileSync(join(fixturesDir, "20034195.pdf")));
/** Live-fetched paper PTR: Hon. Chuck Fleischmann (TN03), filed 2026-02-09. */
const scanPdf = new Uint8Array(readFileSync(join(fixturesDir, "8221321.pdf")));

const engines: PdfTextEngine[] = hasPdftotext() ? ["pdftotext", "pdfjs"] : ["pdfjs"];

describe.each(engines)("extractPdfText + parsePtrText via %s", (engine) => {
  it("extracts real text from the e-filed PDF", async () => {
    const { text } = await extractPdfText(textPdf, engine);
    expect(looksScanned(text)).toBe(false);
    expect(text).toContain("APOLLO DEBT SOLUTIONS BDC");
    expect(text).toContain("20034195");
  });

  it("parses all 8 transactions with owner, side, dates and ranges", async () => {
    const { text } = await extractPdfText(textPdf, engine);
    const rows = parsePtrText(text);
    expect(rows.length).toBe(8);
    // Every row in this filing belongs to the spouse (SP).
    expect(rows.every((r) => r.ownerCode === "SP")).toBe(true);
    expect(rows.filter((r) => r.typeCode === "P").length).toBe(5);
    expect(rows.filter((r) => r.typeCode === "S").length).toBe(3);

    const apollo = rows.find((r) => r.assetRaw.startsWith("APOLLO"));
    expect(apollo).toMatchObject({
      typeCode: "P",
      transactionDate: "2026-02-04",
      notificationDate: "2026-03-06",
      amountLo: 1001,
      amountHi: 15000,
    });
    // Wrapped asset-name line is joined back on.
    expect(apollo?.assetRaw).toContain("CLASS S [OT]");
  });

  it("splits the type letter off an asset that crowds the type column", async () => {
    // In this row the "S" (sale) sits one space after the asset text, and the
    // amount's upper bound wraps to the following line.
    const { text } = await extractPdfText(textPdf, engine);
    const barclays = parsePtrText(text).find((r) => r.assetRaw.startsWith("BARCLAYS"));
    expect(barclays).toMatchObject({
      typeCode: "S",
      transactionDate: "2026-02-19",
      amountLo: 100001,
      amountHi: 250000,
    });
    expect(barclays?.assetRaw).not.toMatch(/\bS\s+BASKET/);
  });

  it("keeps parenthesized fund tickers in the asset text", async () => {
    const { text } = await extractPdfText(textPdf, engine);
    const kkr = parsePtrText(text).find((r) => r.assetRaw.includes("KKR"));
    expect(kkr?.assetRaw).toContain("(KRSOX)");
  });

  it("yields no text for the paper scan (classified for OCR, not parsed)", async () => {
    const { text } = await extractPdfText(scanPdf, engine);
    expect(looksScanned(text)).toBe(true);
    expect(parsePtrText(text)).toEqual([]);
  });
});

describe("extractPdfText failure", () => {
  it("wraps engine failures in a typed pdf-extract error", async () => {
    await expect(extractPdfText(new Uint8Array([1, 2, 3]), "pdfjs")).rejects.toMatchObject({
      name: "HouseIngestError",
      code: "pdf-extract",
    });
  });
});
