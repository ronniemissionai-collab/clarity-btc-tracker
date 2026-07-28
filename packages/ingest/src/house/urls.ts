/** Verified House Clerk endpoints (research ticket 09, probed 2026-07-27). */

const BASE = "https://disclosures-clerk.house.gov/public_disc";

/** Yearly financial-disclosure index zip ({YYYY}FD.xml + .txt inside). */
export function houseIndexUrl(year: number): string {
  return `${BASE}/financial-pdfs/${year}FD.zip`;
}

/** Periodic Transaction Report PDF. */
export function ptrPdfUrl(year: number, docId: string): string {
  return `${BASE}/ptr-pdfs/${year}/${docId}.pdf`;
}

/** Annual/other FD-type PDF (not used for PTRs; kept for completeness). */
export function financialPdfUrl(year: number, docId: string): string {
  return `${BASE}/financial-pdfs/${year}/${docId}.pdf`;
}
