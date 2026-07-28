/**
 * Parser for House Clerk legacy EVS roll-call XML,
 * e.g. https://clerk.house.gov/evs/2025/roll199.xml (CLARITY House passage).
 *
 * The Clerk's <legislator name-id> is the bioguide id, so House votes carry a
 * full per-member breakdown into the shared Bill type.
 */
import { parseClerkActionDate } from "./dates.js";
import type { BillVote, MemberVote, MemberVoteValue, PartyTally } from "./types.js";
import { child, children, childText, parseXml } from "./xml.js";

export interface HouseRollMemberVote {
  bioguideId: string;
  name: string;
  party: string;
  state: string;
  vote: MemberVoteValue;
}

export interface HouseRollCall {
  congress: number;
  session: string;
  rollNumber: number;
  /** e.g. "H R 3633". */
  legisNum: string;
  question: string;
  result: string;
  /** ISO date. */
  date: string;
  totals: { yea: number; nay: number; present: number; notVoting: number };
  /** Keyed by party code (R / D / I). */
  byParty: Record<string, PartyTally>;
  members: HouseRollMemberVote[];
}

const PARTY_CODES: Record<string, string> = {
  republican: "R",
  democratic: "D",
  democrat: "D",
  independent: "I",
};

function mapVoteCast(raw: string): MemberVoteValue | undefined {
  switch (raw.trim().toLowerCase()) {
    case "yea":
    case "aye":
      return "yea";
    case "nay":
    case "no":
      return "nay";
    case "present":
      return "present";
    case "not voting":
      return "not-voting";
    default:
      return undefined;
  }
}

/** Does the raw legis-num refer to this bill? "H R 3633" ~ "H.R. 3633" ~ "hr3633". */
export function normalizeBillNumber(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseHouseRoll(xmlText: string): HouseRollCall {
  const root = parseXml(xmlText);
  const meta = child(root, "vote-metadata");
  if (meta === undefined) throw new Error("EVS roll XML has no <vote-metadata>");

  const byParty: Record<string, PartyTally> = {};
  const totalsEl = child(meta, "vote-totals");
  let totals = { yea: 0, nay: 0, present: 0, notVoting: 0 };
  if (totalsEl !== undefined) {
    for (const partyRow of children(totalsEl, "totals-by-party")) {
      const partyName = childText(partyRow, "party");
      const code = PARTY_CODES[partyName.toLowerCase()] ?? partyName;
      byParty[code] = {
        yea: Number(childText(partyRow, "yea-total")),
        nay: Number(childText(partyRow, "nay-total")),
        present: Number(childText(partyRow, "present-total")),
        notVoting: Number(childText(partyRow, "not-voting-total")),
      };
    }
    const overall = child(totalsEl, "totals-by-vote");
    if (overall !== undefined) {
      totals = {
        yea: Number(childText(overall, "yea-total")),
        nay: Number(childText(overall, "nay-total")),
        present: Number(childText(overall, "present-total")),
        notVoting: Number(childText(overall, "not-voting-total")),
      };
    }
  }

  const members: HouseRollMemberVote[] = [];
  const data = child(root, "vote-data");
  if (data !== undefined) {
    for (const recorded of children(data, "recorded-vote")) {
      const legislator = child(recorded, "legislator");
      if (legislator === undefined) continue;
      const vote = mapVoteCast(childText(recorded, "vote"));
      const bioguideId = legislator.attrs["name-id"] ?? "";
      if (vote === undefined || bioguideId === "") continue;
      const inlineName = legislator.children
        .filter((n): n is string => typeof n === "string")
        .join("")
        .trim();
      members.push({
        bioguideId,
        name: legislator.attrs["unaccented-name"] ?? inlineName,
        party: legislator.attrs["party"] ?? "",
        state: legislator.attrs["state"] ?? "",
        vote,
      });
    }
  }

  return {
    congress: Number(childText(meta, "congress")),
    session: childText(meta, "session"),
    rollNumber: Number(childText(meta, "rollcall-num")),
    legisNum: childText(meta, "legis-num"),
    question: childText(meta, "vote-question"),
    result: childText(meta, "vote-result"),
    date: parseClerkActionDate(childText(meta, "action-date")),
    totals,
    byParty,
    members,
  };
}

/** House question -> shared vote type; undefined for procedural questions we skip. */
export function classifyHouseQuestion(question: string): BillVote["type"] | undefined {
  const q = question.toLowerCase();
  if (q.includes("passage") || q.includes("suspend the rules and pass")) return "passage";
  // A House vote to agree to the Senate amendment IS the re-passage vote.
  if (q.includes("agree") && q.includes("senate amendment")) return "passage";
  return undefined;
}

function mapResult(result: string): "passed" | "failed" {
  const r = result.toLowerCase();
  return r.includes("passed") || r.includes("agreed") ? "passed" : "failed";
}

const BIOGUIDE_RE = /^[A-Z]\d{6}$/;

/**
 * Convert a parsed Clerk roll into the shared BillVote shape (with per-member
 * breakdown). Returns undefined for questions that are neither passage nor a
 * vote to agree to the Senate amendment.
 */
export function houseRollToBillVote(roll: HouseRollCall, rollUrl: string): BillVote | undefined {
  const type = classifyHouseQuestion(roll.question);
  if (type === undefined) return undefined;
  const memberVotes: MemberVote[] = roll.members
    .filter((m) => BIOGUIDE_RE.test(m.bioguideId))
    .map((m) => ({ bioguideId: m.bioguideId, vote: m.vote }));
  return {
    type,
    chamber: "house",
    date: roll.date,
    question: roll.question,
    result: mapResult(roll.result),
    yea: roll.totals.yea,
    nay: roll.totals.nay,
    present: roll.totals.present,
    notVoting: roll.totals.notVoting,
    rollUrl,
    byParty: roll.byParty,
    memberVotes,
  };
}
