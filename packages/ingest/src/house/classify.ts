import type { DocChannel } from "./types.js";

/**
 * DocID -> filing channel (verified against live 2026 PDFs, research ticket 09):
 * 8-digit DocIDs starting "2" are e-filed and render true text PDFs; 7-digit
 * DocIDs starting "8" or "9" are paper filings scanned to image-only PDFs.
 * (Other shapes exist for non-PTR types, e.g. 1xxxxxxx candidate reports.)
 */
export function classifyDocId(docId: string): DocChannel {
  if (/^2\d{7}$/.test(docId)) return "electronic";
  if (/^[89]\d{6}$/.test(docId)) return "paper";
  return "unknown";
}

/**
 * Belt-and-braces text check: image-only scans yield only whitespace/form
 * feeds from text extraction (observed: 2-56 bytes on live paper PTRs).
 */
export function looksScanned(extractedText: string): boolean {
  return extractedText.replace(/\s/g, "").length < 40;
}
