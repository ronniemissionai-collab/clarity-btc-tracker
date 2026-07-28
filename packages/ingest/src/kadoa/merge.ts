/**
 * Merge official-source trades (House Clerk / Senate eFD ingest) with
 * kadoa-normalized trades.
 *
 * Precedence: official rows always win. A kadoa row matching an official row
 * (same member + security/asset + transaction date + side) marks that row
 * provenance "both"; disagreements on range/filing date/lateness are recorded
 * as conflicts but the official values are kept. Kadoa rows with no official
 * counterpart come through with provenance "kadoa" and are classified either
 * as historical backfill (filed before our official coverage window) or as
 * rows the official ingest missed (inside the window — investigate those).
 */
import { securityKey, type Trade } from "@clarity-btc/shared";

export type TradeProvenance = "official" | "kadoa" | "both";

export interface MergedTrade extends Trade {
  provenance: TradeProvenance;
}

export interface TradeConflict {
  /** The row we keep. */
  official: Trade;
  /** The kadoa row that disagrees. */
  kadoa: Trade;
  /** Which fields disagreed, e.g. ["range.hi", "filedDate"]. */
  fields: string[];
}

export interface MergeTradesOptions {
  /**
   * ISO date the official ingest coverage starts at. Kadoa-only rows FILED on
   * or after this date are flagged as missed by the official ingest; earlier
   * rows are historical backfill. Defaults to the earliest official filedDate
   * (no official rows -> everything is backfill).
   */
  officialCoverageStart?: string;
}

export interface MergeTradesResult {
  /** All rows, official + kadoa-only, each stamped with provenance. */
  merged: MergedTrade[];
  /** Kadoa-only rows filed before the official coverage window. */
  backfilled: MergedTrade[];
  /** Kadoa-only rows the official ingest should have seen — investigate. */
  missedByOfficial: MergedTrade[];
  /** Matched rows that disagree on details (official values kept). */
  conflicts: TradeConflict[];
}

/** Identity key: member + security (or raw asset text) + tx date + side. */
export function tradeMatchKey(trade: Trade): string {
  const asset =
    trade.security !== null
      ? securityKey(trade.security)
      : `raw:${trade.assetRaw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
  return [trade.memberId, asset, trade.transactionDate, trade.side].join("|");
}

function diffFields(official: Trade, kadoa: Trade): string[] {
  const fields: string[] = [];
  if (official.range.lo !== kadoa.range.lo) fields.push("range.lo");
  if (official.range.hi !== kadoa.range.hi) fields.push("range.hi");
  if (official.filedDate !== kadoa.filedDate) fields.push("filedDate");
  if (official.late !== kadoa.late) fields.push("late");
  if (
    official.owner !== undefined &&
    kadoa.owner !== undefined &&
    official.owner !== kadoa.owner
  ) {
    fields.push("owner");
  }
  return fields;
}

function byDateDesc(a: Trade, b: Trade): number {
  if (a.transactionDate !== b.transactionDate) {
    return a.transactionDate < b.transactionDate ? 1 : -1;
  }
  if (a.memberId !== b.memberId) return a.memberId < b.memberId ? -1 : 1;
  return a.assetRaw < b.assetRaw ? -1 : a.assetRaw > b.assetRaw ? 1 : 0;
}

export function mergeTrades(
  official: Trade[],
  kadoa: Trade[],
  options: MergeTradesOptions = {},
): MergeTradesResult {
  // Same-day repeat trades are real (e.g. two BITB buys in one filing), so
  // buckets hold lists and each official row can absorb exactly one kadoa row.
  const buckets = new Map<string, MergedTrade[]>();
  const officialMerged: MergedTrade[] = official.map((t) => ({
    ...t,
    provenance: "official" as TradeProvenance,
  }));
  for (const row of officialMerged) {
    const key = tradeMatchKey(row);
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [row]);
    else list.push(row);
  }

  const coverageStart =
    options.officialCoverageStart ??
    (official.length > 0
      ? official.map((t) => t.filedDate).sort()[0]
      : undefined);

  const conflicts: TradeConflict[] = [];
  const backfilled: MergedTrade[] = [];
  const missedByOfficial: MergedTrade[] = [];
  const kadoaOnly: MergedTrade[] = [];

  for (const row of kadoa) {
    const bucket = buckets.get(tradeMatchKey(row));
    const claimed = bucket?.find((o) => o.provenance === "official");
    if (claimed !== undefined) {
      claimed.provenance = "both";
      const fields = diffFields(claimed, row);
      if (fields.length > 0) {
        // Official wins; record the disagreement for the cross-check report.
        const { provenance: _p, ...officialPlain } = claimed;
        conflicts.push({ official: officialPlain, kadoa: row, fields });
      }
      continue;
    }
    const mergedRow: MergedTrade = { ...row, provenance: "kadoa" };
    kadoaOnly.push(mergedRow);
    if (coverageStart !== undefined && row.filedDate >= coverageStart) {
      missedByOfficial.push(mergedRow);
    } else {
      backfilled.push(mergedRow);
    }
  }

  const merged = [...officialMerged, ...kadoaOnly].sort(byDateDesc);
  return { merged, backfilled, missedByOfficial, conflicts };
}
