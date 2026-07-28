/**
 * View model derived from validated data — every number the page shows
 * (hero counts, stat cards, tier buckets, range-bar scale, trader ranking)
 * is computed here from data/*.json, never hardcoded.
 */
import {
  securityKey,
  type Bill,
  type Holding,
  type Member,
  type Party,
  type Security,
  type Trade,
  type Trader,
  type ValueRange,
} from "@clarity-btc/shared";
import type { AppData } from "./data";
import type { SparkPoint } from "./components/sparkline";

/** The shared package exports BillVoteSchema but not the inferred type. */
export type BillVote = Bill["votes"][number];

/** One holding joined to its member + resolved security (tier comes from the universe config). */
export interface HoldingRow {
  holding: Holding;
  member: Member;
  security: Security | undefined;
  tier: 1 | 2;
  /** Official filing URL — mandatory in the schema, so always present. */
  filingUrl: string;
}

/** All of one member's Tier 1 rows, for the party-column layout. */
export interface MemberGroup {
  member: Member;
  rows: HoldingRow[];
  /** Highest disclosed hi across the member's rows (sold rows count 0). */
  maxHi: number;
}

export type VoteStatus =
  | { kind: "recorded"; vote: "yea" | "nay" | "present" | "not-voting" }
  | { kind: "senate-pending" }
  | { kind: "unrecorded" };

export interface RankedTrader {
  rank: number;
  trader: Trader;
  member: Member | undefined;
  /** Real per-trade points (range midpoints over transaction dates) from trades.json. */
  series: SparkPoint[];
}

export interface Model {
  bill: Bill;
  housePassage: BillVote | undefined;
  /** Distinct members with a current (non-sold) holding in the universe. */
  holderCount: number;
  /** Rows dropped because they reference departed members or lack a filing URL. */
  unattributedHoldings: number;
  /** Distinct Tier 1 current holders by party. */
  tier1HoldersByParty: Map<Party, number>;
  /** Sum of lo / sum of hi over all current holdings (ranges sum band-wise). */
  combinedExposure: ValueRange;
  /** Members with any Tier 1 row (sold-out members included, shown with SOLD chips), by party. */
  tier1Columns: Map<Party, MemberGroup[]>;
  /** Tier 2 rows for the subordinate table. */
  tier2Rows: HoldingRow[];
  /** Scale for Tier 1 range bars: max disclosed hi among current Tier 1 rows. */
  tier1MaxHi: number;
  voteFor: (member: Member) => VoteStatus;
  rankedTraders: RankedTrader[];
}

const isCurrent = (h: Holding): boolean => h.status !== "sold";

export function midpoint(r: ValueRange): number {
  return (r.lo + r.hi) / 2;
}

/** Per-trade points for a member's sparkline: disclosed range midpoints over time. */
export function tradeSeries(trades: Trade[], memberId: string): SparkPoint[] {
  return trades
    .filter((t) => t.memberId === memberId)
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate))
    .map((t) => ({ date: t.transactionDate, value: midpoint(t.range) }));
}

export function buildModel(data: AppData): Model {
  const memberById = new Map(data.members.map((m) => [m.bioguideId, m]));
  const securityByKey = new Map(data.universe.universe.map((s) => [securityKey(s), s]));

  // Live data can reference members who have since left Congress (kadoa backfill);
  // those rows are dropped from display and surfaced only as a count.
  let unattributedHoldings = 0;
  const rows: HoldingRow[] = [];
  for (const holding of data.holdings) {
    const member = memberById.get(holding.memberId);
    const filing = holding.sources.find((s) => s.kind === "filing");
    if (!member || !filing) {
      unattributedHoldings += 1;
      continue;
    }
    const security = securityByKey.get(securityKey(holding.security));
    rows.push({ holding, member, security, tier: security?.tier ?? 2, filingUrl: filing.url });
  }

  const tier1Rows = rows.filter((r) => r.tier === 1);
  const tier2Rows = rows.filter((r) => r.tier === 2);

  // --- counts -------------------------------------------------------------
  const currentHolderIds = new Set(
    rows.filter((r) => isCurrent(r.holding) && r.member.active !== false).map((r) => r.member.bioguideId),
  );

  const tier1HoldersByParty = new Map<Party, number>();
  const seenTier1 = new Set<string>();
  for (const r of tier1Rows) {
    if (!isCurrent(r.holding) || r.member.active === false || seenTier1.has(r.member.bioguideId)) continue;
    seenTier1.add(r.member.bioguideId);
    tier1HoldersByParty.set(r.member.party, (tier1HoldersByParty.get(r.member.party) ?? 0) + 1);
  }

  const combinedExposure = rows
    .filter((r) => isCurrent(r.holding))
    .reduce<ValueRange>((acc, r) => ({ lo: acc.lo + r.holding.range.lo, hi: acc.hi + r.holding.range.hi }), {
      lo: 0,
      hi: 0,
    });

  // --- Tier 1 party columns ----------------------------------------------
  const groupsById = new Map<string, MemberGroup>();
  for (const r of tier1Rows) {
    let group = groupsById.get(r.member.bioguideId);
    if (!group) {
      group = { member: r.member, rows: [], maxHi: 0 };
      groupsById.set(r.member.bioguideId, group);
    }
    group.rows.push(r);
    if (isCurrent(r.holding)) group.maxHi = Math.max(group.maxHi, r.holding.range.hi);
  }
  const tier1Columns = new Map<Party, MemberGroup[]>();
  for (const group of groupsById.values()) {
    group.rows.sort((a, b) => b.holding.range.hi - a.holding.range.hi);
    const list = tier1Columns.get(group.member.party) ?? [];
    list.push(group);
    tier1Columns.set(group.member.party, list);
  }
  for (const list of tier1Columns.values()) {
    list.sort((a, b) => b.maxHi - a.maxHi || a.member.name.localeCompare(b.member.name));
  }

  const tier1MaxHi = tier1Rows
    .filter((r) => isCurrent(r.holding))
    .reduce((max, r) => Math.max(max, r.holding.range.hi), 0);

  // --- votes ---------------------------------------------------------------
  const housePassage = data.bill.votes.find((v) => v.type === "passage" && v.chamber === "house");
  const passageByChamber = new Map(
    data.bill.votes.filter((v) => v.type === "passage").map((v) => [v.chamber, v]),
  );

  const voteFor = (member: Member): VoteStatus => {
    const vote = passageByChamber.get(member.chamber);
    if (!vote) {
      // Cloture and committee votes are never rendered as a member's floor vote.
      return member.chamber === "senate" ? { kind: "senate-pending" } : { kind: "unrecorded" };
    }
    const recorded = vote.memberVotes?.find((mv) => mv.bioguideId === member.bioguideId);
    return recorded ? { kind: "recorded", vote: recorded.vote } : { kind: "unrecorded" };
  };

  // --- traders -------------------------------------------------------------
  const rankedTraders = [...data.traders]
    .sort((a, b) => b.tradeCount - a.tradeCount)
    .map((trader, i) => ({
      rank: i + 1,
      trader,
      member: memberById.get(trader.memberId),
      series: tradeSeries(data.trades, trader.memberId),
    }));

  return {
    bill: data.bill,
    housePassage,
    holderCount: currentHolderIds.size,
    unattributedHoldings,
    tier1HoldersByParty,
    combinedExposure,
    tier1Columns,
    tier2Rows,
    tier1MaxHi,
    voteFor,
    rankedTraders,
  };
}
