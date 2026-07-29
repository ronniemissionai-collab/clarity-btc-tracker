/**
 * Universe membership/tier lookup for the holdings view, keyed by the shared
 * composite security key (ticker + kind - "BTC:direct" vs "BTC:spot-etf" are
 * distinct entries).
 *
 * Raw filing-text resolution (alias matching for non-ticker "Bitcoin" lines,
 * the BTC ticker-collision rule) lives in the ingest resolvers -
 * house/resolve.ts, senate/resolve.ts, kadoa/resolve.ts - which each handle a
 * different input shape. By the time rows reach the holdings derivation they
 * carry resolved SecurityRefs, so this module only needs key membership.
 */
import type { PortfolioSecurityRef, Security, UniverseConfig } from "@clarity-btc/shared";
import { securityKey } from "@clarity-btc/shared";

export interface UniverseIndex {
  /** All universe securities, as configured. */
  securities: Security[];
  /** Is this resolved ref part of the configured universe? (Portfolio refs allowed; kind "other" is never a member.) */
  has(ref: PortfolioSecurityRef): boolean;
  /** Tier of the ref's universe entry, or null when outside the universe. */
  tierOf(ref: PortfolioSecurityRef): 1 | 2 | null;
}

export function buildUniverseIndex(universe: UniverseConfig | Security[]): UniverseIndex {
  const securities = Array.isArray(universe) ? universe : universe.universe;
  const byKey = new Map<string, Security>();
  for (const sec of securities) {
    byKey.set(securityKey(sec), sec);
  }
  return {
    securities,
    has: (ref) => byKey.has(securityKey(ref)),
    tierOf: (ref) => byKey.get(securityKey(ref))?.tier ?? null,
  };
}
