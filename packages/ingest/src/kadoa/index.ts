/**
 * Pipeline step 3: kadoa backfill + daily cross-check.
 *
 * Fetches the MIT-licensed congress-trading-monitor datasets (recent-window
 * trades.json, the filer directory, and full per-filer histories for the
 * members we track), normalizes them onto the shared `Trade` contract, and
 * merges against the official-source rows from steps 1-2. Official rows win
 * on conflict; kadoa supplies historical backfill (per-filer files reach back
 * to 2012-era filings) and flags rows the official ingest missed. Every merged
 * row records provenance ("official" | "kadoa" | "both").
 */
import type { Member, Security, Trade } from "@clarity-btc/shared";
import {
  fetchKadoaFilers,
  fetchKadoaFilerTrades,
  fetchKadoaTrades,
  type KadoaFetchOptions,
} from "./fetch.js";
import { normalizeKadoaTrades, type KadoaSkippedRow } from "./normalize.js";
import { mergeTrades, type MergeTradesResult } from "./merge.js";
import type { KadoaFiler, KadoaTradeRow } from "./types.js";
import { buildMemberMatcher } from "./members.js";

export {
  KADOA_BASE_URL,
  fetchKadoaFilers,
  fetchKadoaFilerTrades,
  fetchKadoaJson,
  fetchKadoaPrices,
  fetchKadoaReturns,
  fetchKadoaTickers,
  fetchKadoaTrades,
  type KadoaDataset,
  type KadoaFetchFn,
  type KadoaFetchOptions,
  type KadoaFetchResponse,
} from "./fetch.js";
export { buildMemberMatcher, nameTokens, type MemberMatcher } from "./members.js";
export {
  buildSecurityResolver,
  normalizeAssetText,
  type ResolveInput,
  type SecurityResolver,
} from "./resolve.js";
export {
  normalizeKadoaTrades,
  type KadoaSkippedRow,
  type NormalizeKadoaOptions,
  type NormalizeKadoaResult,
} from "./normalize.js";
export {
  chamberOfDocUrl,
  cleanAssetText,
  mergeTrades,
  tradeMatchKey,
  type MergedTrade,
  type MergeTradesOptions,
  type MergeTradesResult,
  type TradeConflict,
  type TradeProvenance,
} from "./merge.js";
export * from "./types.js";

export interface KadoaCrossCheckOptions {
  /** Member roster (data/members.json). */
  members: Member[];
  /** Security universe (config/universe.json -> universe array). */
  universe: Security[];
  /**
   * ISO date official ingest coverage starts at; kadoa-only rows filed on or
   * after it are flagged missed, earlier ones are backfill.
   */
  officialCoverageStart?: string;
  /** Per-chamber coverage starts (see MergeTradesOptions.coverageStarts). */
  coverageStarts?: { house?: string; senate?: string };
  /**
   * Per-filer histories to pull for backfill. Default: every kadoa congress
   * filer that matches the member roster (the top-level trades.json only
   * covers the most recent filings window).
   */
  filerIds?: string[];
  /** Fetch/caching knobs (tests inject fetchFn; no network in tests). */
  fetch?: KadoaFetchOptions;
}

export interface KadoaCrossCheckResult extends MergeTradesResult {
  /** Count of kadoa rows normalized onto the Trade contract. */
  normalized: number;
  /** Rows dropped during normalization, with reasons. */
  skipped: KadoaSkippedRow[];
  /** Congress filer names (with a party) that aren't on our roster. */
  unmatchedFilers: string[];
}

/** Pick the kadoa filer ids whose names resolve to our member roster. */
export function selectRosterFilerIds(filers: KadoaFiler[], members: Member[]): string[] {
  const matcher = buildMemberMatcher(members);
  return filers
    .filter(
      (f) =>
        f.branch === "congress" &&
        f.party != null &&
        f.party !== "" &&
        matcher.match(f.full_name, f.chamber) !== undefined,
    )
    .map((f) => f.id)
    .sort();
}

export async function crossCheckKadoa(
  officialTrades: Trade[],
  options: KadoaCrossCheckOptions,
): Promise<KadoaCrossCheckResult> {
  const fetchOpts = options.fetch ?? {};
  const [recentRows, filers] = await Promise.all([
    fetchKadoaTrades(fetchOpts),
    fetchKadoaFilers(fetchOpts),
  ]);

  const filerIds = options.filerIds ?? selectRosterFilerIds(filers, options.members);
  const rows: KadoaTradeRow[] = [...recentRows];
  for (const filerId of filerIds) {
    try {
      const file = await fetchKadoaFilerTrades(filerId, fetchOpts);
      rows.push(...file.trades);
    } catch {
      // A missing per-filer file only costs backfill depth for that member;
      // the recent-window rows still cover them.
    }
  }

  const normalized = normalizeKadoaTrades(rows, {
    members: options.members,
    universe: options.universe,
    filers,
  });

  const mergeResult = mergeTrades(officialTrades, normalized.trades, {
    ...(options.officialCoverageStart !== undefined
      ? { officialCoverageStart: options.officialCoverageStart }
      : {}),
    ...(options.coverageStarts !== undefined
      ? { coverageStarts: options.coverageStarts }
      : {}),
  });

  return {
    ...mergeResult,
    normalized: normalized.trades.length,
    skipped: normalized.skipped,
    unmatchedFilers: normalized.unmatchedFilers,
  };
}
