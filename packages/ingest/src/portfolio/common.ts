/**
 * v1.2 pipeline step: common-holdings aggregation (spec "v1.2 - common
 * holdings view", build ticket 17).
 *
 * From the SAME derived all-ticker positions and resolved trades the
 * per-member portfolio files ship, data/common.json gets one row per security
 * held by >= 2 members at once:
 *
 *   - ownersCount counts DISTINCT members with a current (non-sold) position;
 *   - partySplit breaks those current owners down by party (sums to
 *     ownersCount - the front-end mini bar);
 *   - owners[] lists every member with a derived position, INCLUDING fully
 *     exited members (status "sold" - rendered with a SOLD chip, never
 *     counted), each with the transaction dates of their disclosed buy
 *     trades in the security (newest first, capped at 10), their aggregate
 *     disclosed range and status;
 *   - securities with fewer than 2 current owners do not ship;
 *   - rows sort ownersCount desc, then ticker, then kind.
 *
 * Ranges aggregate the documented way (lo and hi summed separately across a
 * member's owner-attribution positions); names resolve from the universe
 * config when known and are omitted otherwise - never guessed.
 */
import type {
  CommonHolding,
  CommonHoldingOwner,
  Member,
  PortfolioPosition,
  Security,
} from "@clarity-btc/shared";
import { securityKey } from "@clarity-btc/shared";
import type { AllTickerTrade } from "../holdings/index.js";

/** Buy dates shipped per owner (newest first) - the view shows a short list. */
export const COMMON_BUY_DATES_CAP = 10;

export interface BuildCommonHoldingsOptions {
  /** data/members.json - owner metadata (positions without a row are skipped). */
  members: readonly Member[];
  /** The SAME derived all-ticker positions the portfolio files ship. */
  positions: readonly PortfolioPosition[];
  /** The SAME resolved all-ticker trades the position derivation consumed. */
  trades: readonly AllTickerTrade[];
  /** config/universe.json securities - resolves display names when known. */
  securities?: readonly Security[];
}

interface MemberGroup {
  memberId: string;
  positions: PortfolioPosition[];
}

function sumRanges(positions: readonly PortfolioPosition[]): { lo: number; hi: number } {
  let lo = 0;
  let hi = 0;
  for (const p of positions) {
    lo += p.range.lo;
    hi += p.range.hi;
  }
  return { lo, hi };
}

function ownerEntry(member: Member, group: MemberGroup, buyDates: string[]): CommonHoldingOwner {
  const current = group.positions.filter((p) => p.status !== "sold");
  const counted = current.length > 0 ? current : group.positions;
  const status: CommonHoldingOwner["status"] =
    current.length === 0 ? "sold" : current.some((p) => p.status === "holds") ? "holds" : "stale";
  return {
    memberId: member.bioguideId,
    name: member.name,
    party: member.party,
    chamber: member.chamber,
    state: member.state,
    active: member.active,
    buyDates,
    latestRange: sumRanges(counted),
    status,
  };
}

export function buildCommonHoldings(options: BuildCommonHoldingsOptions): CommonHolding[] {
  const memberById = new Map(options.members.map((m) => [m.bioguideId, m]));
  const nameByKey = new Map<string, string>(
    (options.securities ?? []).map((s) => [securityKey(s), s.name]),
  );

  // Buy transaction dates per security + member, newest first, capped.
  const buysByOwner = new Map<string, string[]>();
  for (const trade of options.trades) {
    if (trade.side !== "buy" || trade.security === null) continue;
    const key = `${securityKey(trade.security)}|${trade.memberId}`;
    const dates = buysByOwner.get(key);
    if (dates === undefined) buysByOwner.set(key, [trade.transactionDate]);
    else dates.push(trade.transactionDate);
  }

  // Group the derived positions by security, then by member.
  const bySecurity = new Map<
    string,
    { security: PortfolioPosition["security"]; byMember: Map<string, MemberGroup> }
  >();
  for (const position of options.positions) {
    const key = securityKey(position.security);
    let entry = bySecurity.get(key);
    if (entry === undefined) {
      entry = { security: position.security, byMember: new Map() };
      bySecurity.set(key, entry);
    }
    const group = entry.byMember.get(position.memberId);
    if (group === undefined) {
      entry.byMember.set(position.memberId, { memberId: position.memberId, positions: [position] });
    } else {
      group.positions.push(position);
    }
  }

  const rows: CommonHolding[] = [];
  for (const [key, entry] of bySecurity) {
    const owners: CommonHoldingOwner[] = [];
    for (const group of entry.byMember.values()) {
      const member = memberById.get(group.memberId);
      if (member === undefined) continue; // no members.json row - no portfolio either
      const buyDates = [...(buysByOwner.get(`${key}|${group.memberId}`) ?? [])]
        .sort((a, b) => b.localeCompare(a))
        .slice(0, COMMON_BUY_DATES_CAP);
      owners.push(ownerEntry(member, group, buyDates));
    }

    const currentOwners = owners.filter((o) => o.status !== "sold");
    if (currentOwners.length < 2) continue; // only securities held in common ship

    const partySplit = { R: 0, D: 0, I: 0 };
    for (const owner of currentOwners) partySplit[owner.party] += 1;

    const latestBuyDate = owners
      .map((o) => o.buyDates[0])
      .filter((d): d is string => d !== undefined)
      .sort((a, b) => b.localeCompare(a))[0];

    // Current owners first, most recent buy first, then name - a stable,
    // readable order for the expanded row.
    owners.sort((a, b) => {
      const aSold = a.status === "sold" ? 1 : 0;
      const bSold = b.status === "sold" ? 1 : 0;
      if (aSold !== bSold) return aSold - bSold;
      const aBuy = a.buyDates[0] ?? "";
      const bBuy = b.buyDates[0] ?? "";
      if (aBuy !== bBuy) return bBuy.localeCompare(aBuy);
      return a.name.localeCompare(b.name);
    });

    rows.push({
      security: entry.security,
      ...(nameByKey.has(key) ? { name: nameByKey.get(key)! } : {}),
      ownersCount: currentOwners.length,
      partySplit,
      latestBuyDate: latestBuyDate ?? null,
      owners,
    });
  }

  rows.sort(
    (a, b) =>
      b.ownersCount - a.ownersCount ||
      a.security.ticker.localeCompare(b.security.ticker) ||
      a.security.kind.localeCompare(b.security.kind),
  );
  return rows;
}
