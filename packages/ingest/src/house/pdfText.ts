/**
 * PDF text extraction with layout-preserving lines.
 *
 * Primary engine: `pdftotext -layout` (poppler) when present on PATH — the
 * GitHub Action installs it. Fallback: pure-TS pdfjs (via unpdf's serverless
 * build), reconstructing layout lines by grouping text items on the same
 * baseline and ordering them by x. Both produce line-per-row text the PTR
 * parser understands.
 */
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HouseIngestError, errorMessage } from "./errors.js";
import type { PdfTextEngine } from "./types.js";

const execFileAsync = promisify(execFile);

let pdftotextChecked = false;
let pdftotextFound = false;

/** Is poppler's pdftotext available on PATH? (cached) */
export function hasPdftotext(): boolean {
  if (!pdftotextChecked) {
    pdftotextChecked = true;
    const probe = spawnSync("pdftotext", ["-v"], { stdio: "ignore" });
    pdftotextFound = probe.error === undefined;
  }
  return pdftotextFound;
}

async function extractWithPdftotext(pdf: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "house-ptr-"));
  const file = join(dir, "doc.pdf");
  try {
    await writeFile(file, pdf);
    const { stdout } = await execFileAsync("pdftotext", ["-layout", file, "-"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface PositionedItem {
  str: string;
  x: number;
  y: number;
}

/** Group items sharing a baseline (y within tolerance) into layout lines. */
function itemsToLines(items: PositionedItem[]): string[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: string[] = [];
  let currentY: number | null = null;
  let current: PositionedItem[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    current.sort((a, b) => a.x - b.x);
    // Join with double spaces so column boundaries survive; the parser
    // normalizes internal whitespace afterwards.
    lines.push(current.map((i) => i.str).join("  "));
    current = [];
  };
  for (const item of sorted) {
    if (currentY === null || Math.abs(item.y - currentY) > 2) {
      flush();
      currentY = item.y;
    }
    current.push(item);
  }
  flush();
  return lines;
}

async function extractWithPdfjs(pdf: Uint8Array): Promise<string> {
  // pdfjs uses Math.sumPrecise (ES2026); polyfill for Node versions without it.
  const mathWithSum = Math as typeof Math & { sumPrecise?: (v: Iterable<number>) => number };
  if (typeof mathWithSum.sumPrecise !== "function") {
    mathWithSum.sumPrecise = (values: Iterable<number>): number => {
      let sum = 0;
      for (const v of values) sum += v;
      return sum;
    };
  }
  const { getDocumentProxy } = await import("unpdf");
  // pdfjs transfers the underlying buffer to its (loopback) worker port;
  // hand it a fresh copy so callers keep their bytes and cloning stays legal.
  const doc = await getDocumentProxy(Uint8Array.from(pdf));
  const pages: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items: PositionedItem[] = [];
      for (const item of content.items) {
        if (!("str" in item) || item.str.trim() === "") continue;
        items.push({ str: item.str, x: item.transform[4] ?? 0, y: item.transform[5] ?? 0 });
      }
      pages.push(itemsToLines(items).join("\n"));
    }
  } finally {
    // The serverless pdfjs build does not always expose destroy(); clean up
    // with whichever teardown the proxy provides.
    const teardown = doc as { destroy?: () => Promise<void>; cleanup?: () => void };
    if (typeof teardown.destroy === "function") await teardown.destroy();
    else if (typeof teardown.cleanup === "function") teardown.cleanup();
  }
  return pages.join("\n\f\n");
}

/** Extract layout text from a PDF. Throws HouseIngestError("pdf-extract"). */
export async function extractPdfText(
  pdf: Uint8Array,
  engine?: PdfTextEngine,
): Promise<{ text: string; engine: PdfTextEngine }> {
  const chosen: PdfTextEngine = engine ?? (hasPdftotext() ? "pdftotext" : "pdfjs");
  try {
    const text =
      chosen === "pdftotext" ? await extractWithPdftotext(pdf) : await extractWithPdfjs(pdf);
    return { text, engine: chosen };
  } catch (err) {
    throw new HouseIngestError("pdf-extract", `${chosen} extraction failed: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}
