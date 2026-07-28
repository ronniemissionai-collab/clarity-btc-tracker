/**
 * Typed errors for the price layer. Every failure mode a caller might want to
 * branch on gets its own class + `code`, so the provider chain can distinguish
 * "this source doesn't cover the ticker" (fall through) from "the request
 * itself broke" (also fall through, but worth surfacing in warnings).
 */

export type PriceErrorCode = "http" | "parse" | "unavailable" | "chain-exhausted";

export class PriceError extends Error {
  readonly code: PriceErrorCode;

  constructor(code: PriceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Network / HTTP-level failure talking to a price source. */
export class PriceFetchError extends PriceError {
  /** HTTP status when the server answered; undefined for transport errors. */
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super("http", message, options);
    this.status = status;
  }
}

/** The source answered but the body wasn't the shape we expect. */
export class PriceParseError extends PriceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("parse", message, options);
  }
}

/** The source is healthy but has no data for this symbol/date. */
export class PriceUnavailableError extends PriceError {
  readonly symbol: string;

  constructor(symbol: string, message: string) {
    super("unavailable", message);
    this.symbol = symbol;
  }
}

/** Every provider in the chain failed; `causes` holds each typed failure. */
export class PriceChainExhaustedError extends PriceError {
  readonly symbol: string;
  readonly causes: PriceError[];

  constructor(symbol: string, causes: PriceError[]) {
    super(
      "chain-exhausted",
      `no price source could answer for ${symbol}: ` +
        causes.map((c) => `[${c.code}] ${c.message}`).join(" | "),
    );
    this.symbol = symbol;
    this.causes = causes;
  }
}

/** Narrow an unknown catch to a PriceError, wrapping anything else. */
export function asPriceError(err: unknown, context: string): PriceError {
  if (err instanceof PriceError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new PriceFetchError(`${context}: ${message}`, undefined, { cause: err });
}
