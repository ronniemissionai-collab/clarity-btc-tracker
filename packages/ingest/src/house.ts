import type { Trade } from "@clarity-btc/shared";

export interface HouseIngestResult {
  /** New PTR DocIDs discovered in the {YYYY}FD.zip diff. */
  newDocIds: string[];
  trades: Trade[];
  /** DocIDs whose PDFs are scans needing tesseract / an OCR flag (~10%). */
  ocrFlagged: string[];
}

/**
 * Pipeline step 1: diff the House Clerk `{YYYY}FD.zip` financial-disclosure
 * index against the last run, fetch new PTR PDFs, extract with pdftotext,
 * fall back to tesseract (or flag `OCR`) for scanned filings.
 *
 * TODO(ingest ticket): implement per the free-ingestion path (research ticket 09).
 */
export async function ingestHouse(): Promise<HouseIngestResult> {
  return { newDocIds: [], trades: [], ocrFlagged: [] };
}
