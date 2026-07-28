/**
 * CLARITY bill-status module (pipeline step 6).
 *
 * Sources (all keyless, verified in research ticket 02):
 *  - GovInfo BILLSTATUS XML - actions chronology, text versions, related bills
 *  - House Clerk EVS roll XML - per-member House votes (bioguide ids)
 *  - Senate LIS vote menu + detail XML - watcher for any new H.R. 3633 vote
 *
 * Invariants: cloture is never passage; Senate passage of the substitute text
 * sets requiresHouseRepassage and is never rendered as law.
 */
export {
  BILLSTATUS_URL,
  CLARITY_BILL,
  SENATE_SESSIONS,
  refreshBill,
  refreshBillDetailed,
  senateVoteMenuUrl,
} from "./refresh.js";
export type { BillRefreshResult, FetchText, RefreshBillOptions } from "./refresh.js";

export { parseBillStatus, classifyTextVersion, isEngrossedSenateAmendment, isHousePassedVersion, isSenateSubstituteVersion } from "./billstatus.js";
export type {
  BillStatusAction,
  BillStatusData,
  BillStatusRelatedBill,
  BillStatusSponsor,
  BillStatusTextVersion,
  RecordedVoteRef,
} from "./billstatus.js";

export { classifyHouseQuestion, houseRollToBillVote, normalizeBillNumber, parseHouseRoll } from "./houseRoll.js";
export type { HouseRollCall, HouseRollMemberVote } from "./houseRoll.js";

export {
  classifySenateQuestion,
  findBillVotesInMenu,
  parseSenateVoteDetail,
  parseSenateVoteMenu,
  senateDetailToBillVote,
  senateMenuHitToBillVote,
  senateVoteDetailUrl,
} from "./senateVotes.js";
export type {
  SenateMemberVote,
  SenateMenuVote,
  SenateRollCall,
  SenateVoteKind,
  SenateVoteMenu,
  SenateWatchHit,
  SenateWatchOptions,
} from "./senateVotes.js";

export { buildStages, deriveMilestones } from "./stages.js";
export type { BillMilestones, Milestone } from "./stages.js";

export { assembleBill, assertNeverLawWithoutEnactment, buildSubstituteWarning, toBillTextVersion, toRelatedBills } from "./assemble.js";
export type { AssembleBillInput, AssembledBill } from "./assemble.js";

export type { BillStage, BillTextVersion, BillVote, BillVoteType, MemberVote, MemberVoteValue, PartyTally, RelatedBill } from "./types.js";
