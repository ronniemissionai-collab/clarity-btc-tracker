/**
 * Match merged `Trade` rows back to raw kadoa rows to reuse kadoa's
 * precomputed per-trade `ret_since` / `excess_since` (vs SPY) - the PRIMARY
 * return source (research ticket 10). Only rows kadoa didn't score fall back
 * to Yahoo pricing.
 *
 * Matching is tiered:
 *  1. exact  - member + date + side + range + normalized asset text;
 *  2. loose  - member + date + side + range (kadoa asset text often differs
 *     from the official filing's wording).
 * Colliding keys are kept only when the colliding rows agree on ticker and
 * return (same-day repeat buys of one ticker do agree); otherwise the key is
 * marked ambiguous and refuses to match.
 */
import type { Member, Trade } from "@clarity-btc/shared";
import { buildMemberMatcher } from "../kadoa/members.js";
import type { KadoaFiler, KadoaTradeRow } from "../kadoa/types.js";

export interface KadoaTradeReturn {
  ticker: string | null;
  assetType: string | null;
  /** kadoa's since-trade return, percent; null when kadoa didn't score the row. */
  retSince: number | null;
  /** kadoa's since-trade excess vs SPY, pp. */
  excessSince: number | null;
}

export interface KadoaReturnLookup {
  find(trade: Trade): KadoaTradeReturn | undefined;
}

function normAsset(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mapSide(transactionType: string | null | undefined): Trade["side"] | undefined {
  if (transactionType == null) return undefined;
  const t = transactionType.trim().toLowerCase();
  if (t.startsWith("purchase")) return "buy";
  if (t.startsWith("sale")) return "sell";
  return undefined;
}

const AMBIGUOUS = Symbol("ambiguous");
type Slot = KadoaTradeReturn | typeof AMBIGUOUS;

function agrees(a: KadoaTradeReturn, b: KadoaTradeReturn): boolean {
  return a.ticker === b.ticker && a.retSince === b.retSince && a.excessSince === b.excessSince;
}

function put(map: Map<string, Slot>, key: string, value: KadoaTradeReturn): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, value);
  } else if (existing !== AMBIGUOUS && !agrees(existing, value)) {
    map.set(key, AMBIGUOUS);
  }
}

function get(map: Map<string, Slot>, key: string): KadoaTradeReturn | undefined {
  const slot = map.get(key);
  return slot === AMBIGUOUS ? undefined : slot;
}

export function buildKadoaReturnLookup(
  rows: KadoaTradeRow[],
  filers: KadoaFiler[],
  members: Member[],
): KadoaReturnLookup {
  const matcher = buildMemberMatcher(members);
  const filersById = new Map(filers.map((f) => [f.id, f]));
  /** filer id -> resolved memberId (cached; per-filer files repeat one filer). */
  const memberByFiler = new Map<string, string | undefined>();

  function resolveMemberId(row: KadoaTradeRow): string | undefined {
    const filer = row.filer_id != null ? filersById.get(row.filer_id) : undefined;
    const name = row.filer_name ?? filer?.full_name;
    if (name === undefined) return undefined;
    const chamber = row.chamber ?? filer?.chamber;
    const cacheKey = row.filer_id ?? name;
    if (memberByFiler.has(cacheKey)) return memberByFiler.get(cacheKey);
    const member = matcher.match(name, chamber);
    memberByFiler.set(cacheKey, member?.bioguideId);
    return member?.bioguideId;
  }

  const exact = new Map<string, Slot>();
  const loose = new Map<string, Slot>();
  const seenIds = new Set<string>();

  for (const row of rows) {
    if (seenIds.has(row.id)) continue; // trades.json overlaps per-filer files
    seenIds.add(row.id);
    const side = mapSide(row.transaction_type);
    if (side === undefined) continue;
    if (row.transaction_date == null) continue;
    if (row.amount_range_low == null || row.amount_range_high == null) continue;
    const memberId = resolveMemberId(row);
    if (memberId === undefined) continue;

    const retSince = typeof row["ret_since"] === "number" ? row["ret_since"] : null;
    const excessSince = typeof row["excess_since"] === "number" ? row["excess_since"] : null;
    const value: KadoaTradeReturn = {
      ticker: row.ticker ?? null,
      assetType: row.asset_type ?? null,
      retSince,
      excessSince,
    };

    const lo = Math.min(row.amount_range_low, row.amount_range_high);
    const hi = Math.max(row.amount_range_low, row.amount_range_high);
    const base = [memberId, row.transaction_date, side, lo, hi].join("|");
    const assetText = row.asset_name?.trim() || row.ticker?.trim();
    if (assetText !== undefined && assetText !== "") {
      put(exact, `${base}|${normAsset(assetText)}`, value);
    }
    if (row.ticker != null && row.ticker.trim() !== "") {
      put(exact, `${base}|${normAsset(row.ticker)}`, value);
    }
    put(loose, base, value);
  }

  return {
    find(trade: Trade): KadoaTradeReturn | undefined {
      const base = [
        trade.memberId,
        trade.transactionDate,
        trade.side,
        trade.range.lo,
        trade.range.hi,
      ].join("|");
      return (
        get(exact, `${base}|${normAsset(trade.assetRaw)}`) ??
        (trade.security !== null
          ? get(exact, `${base}|${normAsset(trade.security.ticker)}`)
          : undefined) ??
        get(loose, base)
      );
    },
  };
}
