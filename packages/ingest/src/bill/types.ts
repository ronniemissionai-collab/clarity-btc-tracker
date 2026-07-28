/**
 * Sub-shapes of the shared Bill contract, derived from the Bill type so this
 * module never drifts from packages/shared (which only exports the top-level
 * entity types).
 */
import type { Bill } from "@clarity-btc/shared";

export type BillVote = Bill["votes"][number];
export type BillVoteType = BillVote["type"];
export type MemberVote = NonNullable<BillVote["memberVotes"]>[number];
export type MemberVoteValue = MemberVote["vote"];
export type PartyTally = NonNullable<BillVote["byParty"]>[string];
export type BillStage = Bill["stages"][number];
export type BillTextVersion = Bill["textVersions"][number];
export type RelatedBill = Bill["relatedBills"][number];
