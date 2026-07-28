/**
 * Typed errors for the Exa review step (pipeline step 5).
 *
 * `ExaError` covers client/transport failures; `ExaBudgetError` is thrown by
 * the client when the strict daily query budget is exhausted. The orchestrator
 * pre-checks the budget so exhaustion normally surfaces as `queriesSkipped`
 * counts on the result, never as a silent cap.
 */

export type ExaErrorCode =
  /** No API key: neither options.apiKey nor EXA_API_KEY in the environment. */
  | "missing-api-key"
  /** Non-2xx HTTP status from api.exa.ai (after the single 5xx retry). */
  | "http"
  /** Response body was not JSON or did not match the Exa search shape. */
  | "bad-response"
  /** fetch itself rejected (DNS, TLS, connection reset). */
  | "network"
  /** The strict daily query budget is exhausted. */
  | "budget-exhausted";

export class ExaError extends Error {
  readonly code: ExaErrorCode;
  /** HTTP status for "http" errors. */
  readonly status: number | undefined;

  constructor(
    code: ExaErrorCode,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExaError";
    this.code = code;
    this.status = options?.status;
  }
}

export class ExaBudgetError extends ExaError {
  /** The configured budget that was exhausted. */
  readonly budget: number;

  constructor(budget: number) {
    super(
      "budget-exhausted",
      `Exa daily query budget of ${budget} exhausted - no further searches this run`,
    );
    this.name = "ExaBudgetError";
    this.budget = budget;
  }
}

/** Normalize an unknown thrown value into a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
