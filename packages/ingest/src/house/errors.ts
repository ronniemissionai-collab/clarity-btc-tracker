/**
 * Typed errors for the House Clerk ingest step.
 *
 * Fatal setup failures (index download/parse, state IO) throw
 * `HouseIngestError` so the pipeline can keep last-good data. Per-document
 * failures never throw: they are collected as `HouseIngestIssue` rows on the
 * result and the DocID is left out of the seen-state so the next run retries.
 */

export type HouseIngestErrorCode =
  /** The {YYYY}FD.zip index could not be fetched (network / HTTP status). */
  | "index-download"
  /** The zip lacked the expected {YYYY}FD.xml entry or was not a zip. */
  | "index-missing-entry"
  /** The XML index could not be parsed into filing rows. */
  | "index-parse"
  /** A PTR PDF could not be fetched (network / HTTP status). */
  | "pdf-download"
  /** Text extraction failed (pdftotext and pdfjs both unusable). */
  | "pdf-extract"
  /** Extracted text did not yield schema-valid transactions. */
  | "ptr-parse"
  /** The resumable state file could not be read or written. */
  | "state-io";

export class HouseIngestError extends Error {
  readonly code: HouseIngestErrorCode;
  /** DocID the failure relates to, when it is document-scoped. */
  readonly docId: string | undefined;

  constructor(
    code: HouseIngestErrorCode,
    message: string,
    options?: { docId?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HouseIngestError";
    this.code = code;
    this.docId = options?.docId;
  }
}

/** Non-fatal, document-scoped problem recorded on the result. */
export interface HouseIngestIssue {
  docId: string | null;
  code: HouseIngestErrorCode;
  message: string;
}

/** Normalize an unknown thrown value into a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
