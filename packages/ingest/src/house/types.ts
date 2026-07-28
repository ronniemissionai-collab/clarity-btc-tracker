import type { Member, Security, Trade, UniverseConfig } from "@clarity-btc/shared";
import type { HouseIngestIssue } from "./errors.js";

/** One row of the Clerk's {YYYY}FD.xml index. */
export interface HouseFiling {
  prefix: string;
  last: string;
  first: string;
  suffix: string;
  /** Clerk filing-type code; PTRs are "P". */
  filingType: string;
  /** Raw Clerk state/district, e.g. "SC03", "AK00". */
  stateDst: string;
  year: number;
  /** ISO date the Clerk recorded the filing. */
  filedDate: string;
  docId: string;
}

/**
 * Filing channel derived from the DocID (verified rule, research ticket 09):
 * 8-digit starting "2" = e-filed (true text PDF); 7-digit starting "8"/"9" =
 * paper (image scan needing OCR).
 */
export type DocChannel = "electronic" | "paper" | "unknown";

/**
 * Stub row for a scanned paper filing. OCR itself runs later in the Action
 * (tesseract); the ingest step only classifies and flags, so downstream can
 * render/queue the row with an `OCR` badge and the official PDF link.
 */
export interface OcrStubRow {
  docId: string;
  docUrl: string;
  /** Resolved member, when the filer matched the roster. */
  memberId: string | null;
  filerName: string;
  stateDst: string;
  filedDate: string;
  extraction: "pdf-ocr";
  ocrPending: true;
  note: string;
}

/** Text filing that parsed but whose filer is not in the member roster. */
export interface UnmatchedFiling {
  docId: string;
  docUrl: string;
  filerName: string;
  stateDst: string;
  filedDate: string;
  transactionCount: number;
}

export interface HouseIngestStats {
  indexFilings: number;
  ptrFilings: number;
  newPtrs: number;
  processed: number;
  /** Exchange ("E") transactions skipped: neither buy nor sell in the contract. */
  skippedExchanges: number;
}

export interface HouseIngestResult {
  year: number;
  /** New PTR DocIDs discovered in the {YYYY}FD.zip diff this run. */
  newDocIds: string[];
  trades: Trade[];
  /** Scanned paper filings flagged for the OCR pass (~10% of PTRs). */
  ocrFlagged: OcrStubRow[];
  /** Parsed filings whose filer could not be resolved to a member. */
  unmatched: UnmatchedFiling[];
  /** Non-fatal per-document failures; their DocIDs will be retried next run. */
  issues: HouseIngestIssue[];
  stats: HouseIngestStats;
}

export type PdfTextEngine = "pdftotext" | "pdfjs";

export interface HouseIngestOptions {
  /** Member roster used to resolve filers to bioguide ids. */
  members: Member[];
  /** Security universe (config/universe.json) used to resolve asset text. */
  universe: UniverseConfig | Security[];
  /** Filing year; defaults to the current UTC year. */
  year?: number;
  /**
   * Path of the resumable JSON state file (seen DocIDs). Omit to process every
   * PTR in the index without persisting (useful for tests / dry runs).
   */
  statePath?: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Force a text-extraction engine; default: pdftotext if on PATH, else pdfjs. */
  pdfEngine?: PdfTextEngine;
  /** Cap PDF downloads per run (backfill batching). Unprocessed stay unseen. */
  maxPdfsPerRun?: number;
}

/** Shape of the resumable state file. */
export interface HouseState {
  version: 1;
  years: Record<string, { seenDocIds: string[] }>;
}
