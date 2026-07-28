/**
 * Pipeline step 6 orchestrator: refresh CLARITY Act (H.R. 3633, 119th) status
 * from the three keyless sources:
 *
 *  1. GovInfo BILLSTATUS XML (actions chronology, text versions, related bills,
 *     recorded-vote references) - keyless mirror of the Congress.gov API.
 *  2. House Clerk EVS roll XML (per-member House votes; roll URLs come from
 *     the BILLSTATUS recordedVotes references, so a future House re-passage
 *     roll is picked up automatically).
 *  3. Senate LIS vote menu + vote detail XML (daily watcher for any new
 *     H.R. 3633 roll call; cloture is never treated as passage).
 */
import type { Bill } from "@clarity-btc/shared";
import type { BillMilestones } from "./stages.js";
import type { SenateWatchHit } from "./senateVotes.js";
import type { BillVote } from "./types.js";
import { assembleBill, assertNeverLawWithoutEnactment } from "./assemble.js";
import { parseBillStatus } from "./billstatus.js";
import { houseRollToBillVote, parseHouseRoll } from "./houseRoll.js";
import {
  findBillVotesInMenu,
  parseSenateVoteDetail,
  parseSenateVoteMenu,
  senateDetailToBillVote,
  senateMenuHitToBillVote,
} from "./senateVotes.js";

// ---------------------------------------------------------------------------
// Constants (verified endpoints, research ticket 02)
// ---------------------------------------------------------------------------

export const CLARITY_BILL = {
  congress: 119,
  billType: "hr",
  number: 3633,
  /** Popular short name; BILLSTATUS short titles carry only the long form. */
  shortTitle: "CLARITY Act",
  label: "H.R. 3633",
} as const;

export const BILLSTATUS_URL =
  "https://www.govinfo.gov/bulkdata/BILLSTATUS/119/hr/BILLSTATUS-119hr3633.xml";

export function senateVoteMenuUrl(congress: number, session: number): string {
  return `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congress}_${session}.xml`;
}

/** 119th Congress, 2nd session - the session in which any Senate floor vote lands. */
export const SENATE_SESSIONS: ReadonlyArray<{ congress: number; session: number }> = [
  { congress: 119, session: 2 },
];

// ---------------------------------------------------------------------------
// Dependencies (injectable so tests never touch the network)
// ---------------------------------------------------------------------------

export type FetchText = (url: string) => Promise<string>;

export interface RefreshBillOptions {
  fetchText?: FetchText;
  /** ISO date stamped as Bill.asOf; defaults to today (UTC). */
  asOf?: string;
  /** Senate sessions to scan for roll calls. */
  senateSessions?: ReadonlyArray<{ congress: number; session: number }>;
  /** Senate vote numbers already processed (watcher state). */
  seenSenateVoteNumbers?: Iterable<number>;
}

export interface BillRefreshResult {
  bill: Bill;
  milestones: BillMilestones;
  /** Every H.R. 3633 roll call found in the Senate menu (incl. procedural). */
  senateWatch: SenateWatchHit[];
  /** Non-fatal problems (e.g. a vote-detail fetch that fell back to menu data). */
  warnings: string[];
}

const USER_AGENT = "clarity-btc-tracker/0.1 (github.com/ronniemissionai-collab; daily status cron)";

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function todayUtc(): string {
  const iso = new Date().toISOString().slice(0, 10);
  return iso;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function refreshBillDetailed(options: RefreshBillOptions = {}): Promise<BillRefreshResult> {
  const fetchText = options.fetchText ?? defaultFetchText;
  const warnings: string[] = [];

  // 1. BILLSTATUS: actions, text versions, related bills, recorded-vote refs.
  const status = parseBillStatus(await fetchText(BILLSTATUS_URL));

  // 2. House rolls referenced by the actions (roll 199 today; any future
  //    re-passage roll appears here automatically). Deduped by URL.
  const houseRollUrls = new Set<string>();
  for (const action of status.actions) {
    for (const ref of action.recordedVotes) {
      if (ref.chamber === "house") houseRollUrls.add(ref.url);
    }
  }
  const houseVotes: BillVote[] = [];
  for (const url of houseRollUrls) {
    try {
      const roll = parseHouseRoll(await fetchText(url));
      const vote = houseRollToBillVote(roll, url);
      if (vote !== undefined) houseVotes.push(vote);
    } catch (error) {
      warnings.push(`house roll ${url}: ${String(error)}`);
    }
  }

  // 3. Senate menu watcher: any new H.R. 3633 roll call (cloture, passage, or
  //    procedural). For each hit, fetch the detail XML for the per-member
  //    breakdown; fall back to menu tallies when the detail is unavailable.
  const sessions = options.senateSessions ?? SENATE_SESSIONS;
  const senateWatch: SenateWatchHit[] = [];
  const senateVotes: BillVote[] = [];
  for (const { congress, session } of sessions) {
    let hits: SenateWatchHit[];
    try {
      const menu = parseSenateVoteMenu(await fetchText(senateVoteMenuUrl(congress, session)));
      hits = findBillVotesInMenu(menu, CLARITY_BILL.label, {
        ...(options.seenSenateVoteNumbers !== undefined
          ? { seenVoteNumbers: options.seenSenateVoteNumbers }
          : {}),
      });
    } catch (error) {
      warnings.push(`senate menu ${congress}-${session}: ${String(error)}`);
      continue;
    }
    senateWatch.push(...hits);
    for (const hit of hits) {
      let vote: BillVote | undefined;
      try {
        const detail = parseSenateVoteDetail(await fetchText(hit.detailUrl));
        vote = senateDetailToBillVote(detail, hit.detailUrl);
      } catch (error) {
        warnings.push(`senate vote detail ${hit.detailUrl}: ${String(error)}; using menu tallies`);
        vote = senateMenuHitToBillVote(hit);
      }
      if (vote !== undefined) senateVotes.push(vote);
    }
  }

  const assembled = assembleBill({
    status,
    houseVotes,
    senateVotes,
    senateWatch,
    asOf: options.asOf ?? todayUtc(),
    shortTitle: CLARITY_BILL.shortTitle,
  });
  // Hard invariant: senate passage of the substitute is never rendered as law.
  assertNeverLawWithoutEnactment(assembled);

  return { bill: assembled.bill, milestones: assembled.milestones, senateWatch, warnings };
}

/**
 * Pipeline entry point (step 6). Returns the refreshed Bill, or null when the
 * refresh failed - the caller keeps the last good data/bill.json in that case.
 */
export async function refreshBill(options: RefreshBillOptions = {}): Promise<Bill | null> {
  try {
    const result = await refreshBillDetailed(options);
    return result.bill;
  } catch (error) {
    console.error(`refreshBill failed: ${String(error)}`);
    return null;
  }
}
