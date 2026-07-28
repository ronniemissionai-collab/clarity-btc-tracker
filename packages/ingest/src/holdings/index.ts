/**
 * Pipeline step 4 (holdings derivation) + step 8 (validation gate).
 * Build ticket 05; rules per the data-model Answer (research ticket 05) and
 * the expectations baseline (research ticket 04).
 */
export {
  deriveHoldings,
  type DeriveHoldingsOptions,
  type DeriveHoldingsResult,
  type HoldingReject,
} from "./derive.js";
export { buildUniverseIndex, type UniverseIndex } from "./universe.js";
export {
  loadExpectations,
  validateHoldings,
  type ValidateHoldingsOptions,
  type ValidationFailure,
  type ValidationReport,
} from "./validate.js";
