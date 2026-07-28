/**
 * Pipeline step 1: House Clerk PTR ingest.
 *
 * Daily flow (research ticket 09, endpoints verified live):
 *   1. GET {YYYY}FD.zip -> parse {YYYY}FD.xml -> filing rows.
 *   2. Diff P-type DocIDs against the resumable state file.
 *   3. e-filed DocIDs (2xxxxxxx): GET ptr-pdfs/{Year}/{DocID}.pdf ->
 *      layout text (pdftotext, pdfjs fallback) -> transaction rows -> Trade[].
 *   4. Paper DocIDs (8/9xxxxxx): image scans — emit an OCR stub row; the
 *      tesseract pass runs later in the Action, not here.
 *
 * Fatal setup failures throw HouseIngestError; per-document failures are
 * collected on the result and retried next run (DocID not marked seen).
 */
import type { Trade } from "@clarity-btc/shared";
import { parseTrade } from "@clarity-btc/shared";
import { classifyDocId, looksScanned } from "./classify.js";
import { HouseIngestError, errorMessage } from "./errors.js";
import type { HouseIngestIssue } from "./errors.js";
import { downloadHouseIndex } from "./indexParser.js";
import { extractPdfText } from "./pdfText.js";
import type { ParsedPtrTransaction } from "./ptrParser.js";
import { parsePtrText } from "./ptrParser.js";
import { buildSecurityResolver, filerDisplayName, resolveHouseMember } from "./resolve.js";
import { emptyHouseState, loadHouseState, saveHouseState, seenDocIds, withSeenDocIds } from "./state.js";
import type {
  HouseFiling,
  HouseIngestOptions,
  HouseIngestResult,
  OcrStubRow,
  UnmatchedFiling,
} from "./types.js";
import { ptrPdfUrl } from "./urls.js";

export { HouseIngestError, errorMessage } from "./errors.js";
export type { HouseIngestErrorCode, HouseIngestIssue } from "./errors.js";
export { classifyDocId, looksScanned } from "./classify.js";
export { clerkDateToIso, downloadHouseIndex, parseHouseIndexXml, parseHouseIndexZip } from "./indexParser.js";
export { extractPdfText, hasPdftotext } from "./pdfText.js";
export { parsePtrText } from "./ptrParser.js";
export type { ParsedPtrTransaction } from "./ptrParser.js";
export {
  buildSecurityResolver,
  districtFromStateDst,
  filerDisplayName,
  resolveHouseMember,
} from "./resolve.js";
export type { SecurityResolver } from "./resolve.js";
export { emptyHouseState, loadHouseState, saveHouseState } from "./state.js";
export type {
  DocChannel,
  HouseFiling,
  HouseIngestOptions,
  HouseIngestResult,
  HouseIngestStats,
  HouseState,
  OcrStubRow,
  PdfTextEngine,
  UnmatchedFiling,
} from "./types.js";
export { financialPdfUrl, houseIndexUrl, ptrPdfUrl } from "./urls.js";

const OWNER_BY_CODE = { SP: "spouse", JT: "joint", DC: "dependent" } as const;

/** STOCK Act reporting window used for the `late` flag, in days. */
const LATE_AFTER_DAYS = 45;

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function toTrades(
  filing: HouseFiling,
  memberId: string,
  rows: ParsedPtrTransaction[],
  resolveSecurity: (assetRaw: string) => Trade["security"],
): { trades: Trade[]; skippedExchanges: number } {
  const trades: Trade[] = [];
  let skippedExchanges = 0;
  for (const row of rows) {
    if (row.typeCode === "E") {
      skippedExchanges += 1;
      continue;
    }
    const notes: string[] = [];
    if (row.partial) notes.push("partial sale");
    if (row.amountHi === null) notes.push("amount upper bound missing from filing text");
    const trade: Trade = {
      memberId,
      assetRaw: row.assetRaw,
      security: resolveSecurity(row.assetRaw),
      side: row.typeCode === "P" ? "buy" : "sell",
      owner: row.ownerCode === null ? "self" : OWNER_BY_CODE[row.ownerCode],
      range: { lo: row.amountLo, hi: row.amountHi ?? row.amountLo },
      transactionDate: row.transactionDate,
      filedDate: filing.filedDate,
      docUrl: ptrPdfUrl(filing.year, filing.docId),
      late: daysBetween(row.transactionDate, filing.filedDate) > LATE_AFTER_DAYS,
    };
    if (notes.length > 0) trade.note = notes.join("; ");
    trades.push(parseTrade(trade));
  }
  return { trades, skippedExchanges };
}

function ocrStub(filing: HouseFiling, memberId: string | null): OcrStubRow {
  return {
    docId: filing.docId,
    docUrl: ptrPdfUrl(filing.year, filing.docId),
    memberId,
    filerName: filerDisplayName(filing),
    stateDst: filing.stateDst,
    filedDate: filing.filedDate,
    extraction: "pdf-ocr",
    ocrPending: true,
    note: "paper filing (image scan) - OCR runs in the Action, flagged here only",
  };
}

export async function ingestHouse(options: HouseIngestOptions): Promise<HouseIngestResult> {
  const year = options.year ?? new Date().getUTCFullYear();
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveSecurity = buildSecurityResolver(options.universe);

  const state = options.statePath ? await loadHouseState(options.statePath) : emptyHouseState();
  const seen = seenDocIds(state, year);

  const filings = await downloadHouseIndex(year, fetchImpl);
  const ptrs = filings.filter((f) => f.filingType === "P");
  let newPtrs = ptrs.filter((f) => !seen.has(f.docId));
  if (options.maxPdfsPerRun !== undefined) {
    newPtrs = newPtrs.slice(0, options.maxPdfsPerRun);
  }

  const trades: Trade[] = [];
  const ocrFlagged: OcrStubRow[] = [];
  const unmatched: UnmatchedFiling[] = [];
  const issues: HouseIngestIssue[] = [];
  let processed = 0;
  let skippedExchanges = 0;

  for (const filing of newPtrs) {
    const member = resolveHouseMember(filing, options.members);

    if (classifyDocId(filing.docId) === "paper") {
      ocrFlagged.push(ocrStub(filing, member?.bioguideId ?? null));
      seen.add(filing.docId);
      processed += 1;
      continue;
    }

    let pdf: Uint8Array;
    try {
      const url = ptrPdfUrl(year, filing.docId);
      const res = await fetchImpl(url);
      if (!res.ok) {
        throw new HouseIngestError("pdf-download", `GET ${url} -> HTTP ${res.status}`, {
          docId: filing.docId,
        });
      }
      pdf = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      issues.push({
        docId: filing.docId,
        code: err instanceof HouseIngestError ? err.code : "pdf-download",
        message: errorMessage(err),
      });
      continue; // not marked seen -> retried next run
    }

    try {
      const { text } = await extractPdfText(pdf, options.pdfEngine);
      if (looksScanned(text)) {
        // Defensive: an e-filed DocID that still yields no text gets the OCR flag.
        ocrFlagged.push(ocrStub(filing, member?.bioguideId ?? null));
        seen.add(filing.docId);
        processed += 1;
        continue;
      }
      const rows = parsePtrText(text);
      if (member === null) {
        unmatched.push({
          docId: filing.docId,
          docUrl: ptrPdfUrl(filing.year, filing.docId),
          filerName: filerDisplayName(filing),
          stateDst: filing.stateDst,
          filedDate: filing.filedDate,
          transactionCount: rows.length,
        });
      } else {
        const built = toTrades(filing, member.bioguideId, rows, resolveSecurity);
        trades.push(...built.trades);
        skippedExchanges += built.skippedExchanges;
      }
      seen.add(filing.docId);
      processed += 1;
    } catch (err) {
      issues.push({
        docId: filing.docId,
        code: err instanceof HouseIngestError ? err.code : "ptr-parse",
        message: errorMessage(err),
      });
      // not marked seen -> retried next run
    }
  }

  if (options.statePath) {
    await saveHouseState(options.statePath, withSeenDocIds(state, year, seen));
  }

  return {
    year,
    newDocIds: newPtrs.map((f) => f.docId),
    trades,
    ocrFlagged,
    unmatched,
    issues,
    stats: {
      indexFilings: filings.length,
      ptrFilings: ptrs.length,
      newPtrs: newPtrs.length,
      processed,
      skippedExchanges,
    },
  };
}
