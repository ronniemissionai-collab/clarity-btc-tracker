/**
 * Typed errors for the Senate eFD ingest step.
 *
 * Every failure surfaces as a `SenateIngestError` subclass with a `kind`
 * discriminant, so the pipeline can distinguish a broken handshake (retry the
 * whole step) from a single unparseable filing (skip it, keep going).
 */

export type SenateErrorKind =
  | "handshake"
  | "search"
  | "filing"
  | "parse"
  | "state";

export class SenateIngestError extends Error {
  readonly kind: SenateErrorKind;

  constructor(kind: SenateErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SenateIngestError";
    this.kind = kind;
  }
}

/** The CSRF/agreement handshake with efdsearch.senate.gov failed. */
export class SenateHandshakeError extends SenateIngestError {
  constructor(message: string, options?: ErrorOptions) {
    super("handshake", message, options);
    this.name = "SenateHandshakeError";
  }
}

/** The DataTables search endpoint returned an error or a malformed payload. */
export class SenateSearchError extends SenateIngestError {
  constructor(message: string, options?: ErrorOptions) {
    super("search", message, options);
    this.name = "SenateSearchError";
  }
}

/** A filing page could not be fetched. */
export class SenateFilingError extends SenateIngestError {
  constructor(message: string, options?: ErrorOptions) {
    super("filing", message, options);
    this.name = "SenateFilingError";
  }
}

/** A fetched page did not match the expected HTML/JSON structure. */
export class SenateParseError extends SenateIngestError {
  constructor(message: string, options?: ErrorOptions) {
    super("parse", message, options);
    this.name = "SenateParseError";
  }
}

/** The persisted last-run state file exists but cannot be read or validated. */
export class SenateStateError extends SenateIngestError {
  constructor(message: string, options?: ErrorOptions) {
    super("state", message, options);
    this.name = "SenateStateError";
  }
}
