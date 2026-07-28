/**
 * Senate LIS vote sources:
 *  - Session vote menu (poll daily to detect any new H.R. 3633 roll call):
 *    https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_2.xml
 *  - Individual vote detail (per-member breakdown):
 *    https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_NNNNN.xml
 *
 * The first Senate roll call on the bill will likely be a cloture motion -
 * classification here is what guarantees cloture is never rendered as passage.
 */
import { parseSenateDetailDate, parseSenateMenuDate } from "./dates.js";
import { normalizeBillNumber } from "./houseRoll.js";
import type { BillVote, MemberVoteValue, PartyTally } from "./types.js";
import { child, children, childText, parseXml } from "./xml.js";

// ---------------------------------------------------------------------------
// Question classification (cloture must NOT map to passage)
// ---------------------------------------------------------------------------

/**
 * "passage" - the substantive vote that passes the measure.
 * "cloture" - any cloture question, including cloture on the motion to proceed.
 * "other"   - procedural questions (motion to proceed, tabling, amendments,
 *             discharge, points of order, nominations, ...). Never treated as
 *             passage and never silently dropped by the watcher.
 */
export type SenateVoteKind = "passage" | "cloture" | "other";

export function classifySenateQuestion(question: string): SenateVoteKind {
  const q = question.toLowerCase();
  // Order matters: "On Cloture on the Motion to Proceed" contains both words.
  if (q.includes("cloture")) return "cloture";
  if (q.includes("passage")) return "passage";
  // Final votes on resolutions are phrased without the word "passage".
  if (/^on the (joint |concurrent )?resolution/.test(q.trim())) return "passage";
  return "other";
}

// ---------------------------------------------------------------------------
// Vote menu
// ---------------------------------------------------------------------------

export interface SenateMenuVote {
  voteNumber: number;
  /** ISO date (menu dates carry no year; resolved via congress_year). */
  date: string;
  issue: string;
  question: string;
  kind: SenateVoteKind;
  result: string;
  yeas: number | undefined;
  nays: number | undefined;
  title: string;
  /** Issues decided en bloc under this vote number, when present. */
  enBlocIssues: string[];
}

export interface SenateVoteMenu {
  congress: number;
  session: number;
  congressYear: number;
  /** Newest first, as the menu orders them. */
  votes: SenateMenuVote[];
}

export function parseSenateVoteMenu(xmlText: string): SenateVoteMenu {
  const root = parseXml(xmlText);
  const congressYear = Number(childText(root, "congress_year"));
  const votesEl = child(root, "votes");
  const votes: SenateMenuVote[] = [];
  if (votesEl !== undefined) {
    for (const vote of children(votesEl, "vote")) {
      const question = childText(vote, "question");
      const tally = child(vote, "vote_tally");
      const yeasText = tally === undefined ? "" : childText(tally, "yeas");
      const naysText = tally === undefined ? "" : childText(tally, "nays");
      const enBloc = child(vote, "en_bloc");
      const enBlocIssues =
        enBloc === undefined
          ? []
          : children(enBloc, "matter")
              .map((m) => childText(m, "issue"))
              .filter((issue) => issue !== "");
      votes.push({
        voteNumber: Number(childText(vote, "vote_number")),
        date: parseSenateMenuDate(childText(vote, "vote_date"), congressYear),
        issue: childText(vote, "issue"),
        question,
        kind: classifySenateQuestion(question),
        result: childText(vote, "result"),
        yeas: yeasText === "" ? undefined : Number(yeasText),
        nays: naysText === "" ? undefined : Number(naysText),
        title: childText(vote, "title"),
        enBlocIssues,
      });
    }
  }
  return {
    congress: Number(childText(root, "congress")),
    session: Number(childText(root, "session")),
    congressYear,
    votes,
  };
}

/** LIS detail URL for a menu entry, e.g. vote1192/vote_119_2_00210.xml. */
export function senateVoteDetailUrl(congress: number, session: number, voteNumber: number): string {
  const padded = String(voteNumber).padStart(5, "0");
  return `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`;
}

// ---------------------------------------------------------------------------
// Watcher: detect any new roll call on the bill (cloture, passage, or other)
// ---------------------------------------------------------------------------

export interface SenateWatchHit {
  voteNumber: number;
  date: string;
  issue: string;
  question: string;
  /** Cloture is deliberately distinct from passage here. */
  kind: SenateVoteKind;
  result: string;
  yeas: number | undefined;
  nays: number | undefined;
  title: string;
  detailUrl: string;
}

export interface SenateWatchOptions {
  /** Vote numbers already processed by a previous run. */
  seenVoteNumbers?: Iterable<number>;
}

/**
 * Scan the session vote menu for roll calls whose issue (or en-bloc matter)
 * is the given bill. Returns hits oldest-first so downstream consumers append
 * chronologically. Every match is reported regardless of question type - the
 * caller decides what enters Bill.votes (passage/cloture) vs what is merely
 * surfaced (procedural votes).
 */
export function findBillVotesInMenu(
  menu: SenateVoteMenu,
  bill: string,
  options: SenateWatchOptions = {},
): SenateWatchHit[] {
  const wanted = normalizeBillNumber(bill);
  const seen = new Set(options.seenVoteNumbers ?? []);
  const hits: SenateWatchHit[] = [];
  for (const vote of menu.votes) {
    if (seen.has(vote.voteNumber)) continue;
    const matches =
      normalizeBillNumber(vote.issue) === wanted ||
      vote.enBlocIssues.some((issue) => normalizeBillNumber(issue) === wanted);
    if (!matches) continue;
    hits.push({
      voteNumber: vote.voteNumber,
      date: vote.date,
      issue: vote.issue,
      question: vote.question,
      kind: vote.kind,
      result: vote.result,
      yeas: vote.yeas,
      nays: vote.nays,
      title: vote.title,
      detailUrl: senateVoteDetailUrl(menu.congress, menu.session, vote.voteNumber),
    });
  }
  return hits.sort((a, b) => a.voteNumber - b.voteNumber);
}

// ---------------------------------------------------------------------------
// Vote detail (per-member breakdown)
// ---------------------------------------------------------------------------

export interface SenateMemberVote {
  /** e.g. "Alsobrooks (D-MD)". */
  memberFull: string;
  lastName: string;
  firstName: string;
  party: string;
  state: string;
  vote: MemberVoteValue;
  /** LIS member id (e.g. "S428") - NOT a bioguide id. */
  lisMemberId: string;
}

export interface SenateRollCall {
  congress: number;
  session: number;
  voteNumber: number;
  /** ISO date. */
  date: string;
  question: string;
  kind: SenateVoteKind;
  resultText: string;
  result: string;
  counts: { yeas: number; nays: number; present: number; absent: number };
  members: SenateMemberVote[];
  /** Keyed by party code (R / D / I), computed from the member list. */
  byParty: Record<string, PartyTally>;
}

function mapSenateVoteCast(raw: string): MemberVoteValue | undefined {
  switch (raw.trim().toLowerCase()) {
    case "yea":
    case "guilty": // impeachment phrasing; counted with yeas by LIS
      return "yea";
    case "nay":
    case "not guilty":
      return "nay";
    case "present":
    case "present, giving live pair":
      return "present";
    case "not voting":
    case "absent":
      return "not-voting";
    default:
      return undefined;
  }
}

export function parseSenateVoteDetail(xmlText: string): SenateRollCall {
  const root = parseXml(xmlText);
  const question = childText(root, "question");

  const members: SenateMemberVote[] = [];
  const byParty: Record<string, PartyTally> = {};
  const membersEl = child(root, "members");
  if (membersEl !== undefined) {
    for (const member of children(membersEl, "member")) {
      const vote = mapSenateVoteCast(childText(member, "vote_cast"));
      if (vote === undefined) continue;
      const party = childText(member, "party");
      members.push({
        memberFull: childText(member, "member_full"),
        lastName: childText(member, "last_name"),
        firstName: childText(member, "first_name"),
        party,
        state: childText(member, "state"),
        vote,
        lisMemberId: childText(member, "lis_member_id"),
      });
      const tally = (byParty[party] ??= { yea: 0, nay: 0, present: 0, notVoting: 0 });
      if (vote === "yea") tally.yea += 1;
      else if (vote === "nay") tally.nay += 1;
      else if (vote === "present") tally.present = (tally.present ?? 0) + 1;
      else tally.notVoting = (tally.notVoting ?? 0) + 1;
    }
  }

  const countEl = child(root, "count");
  const num = (name: string): number => {
    const text = countEl === undefined ? "" : childText(countEl, name);
    return text === "" ? 0 : Number(text);
  };

  return {
    congress: Number(childText(root, "congress")),
    session: Number(childText(root, "session")),
    voteNumber: Number(childText(root, "vote_number")),
    date: parseSenateDetailDate(childText(root, "vote_date")),
    question,
    kind: classifySenateQuestion(question),
    resultText: childText(root, "vote_result_text"),
    result: childText(root, "vote_result"),
    counts: { yeas: num("yeas"), nays: num("nays"), present: num("present"), absent: num("absent") },
    members,
    byParty,
  };
}

// ---------------------------------------------------------------------------
// Conversion into the shared BillVote shape
// ---------------------------------------------------------------------------

function mapSenateResult(result: string): "passed" | "failed" {
  const r = result.toLowerCase();
  return r.includes("agreed") || r.includes("passed") || r.includes("confirmed") ? "passed" : "failed";
}

/**
 * Convert a Senate roll call into the shared BillVote shape. Only cloture and
 * passage votes are representable in the contract; procedural votes return
 * undefined (they stay visible through the watcher, not through Bill.votes).
 *
 * Per-member votes ship on `senateMemberVotes` (LIS ids, e.g. "S428") - the
 * LIS feed has no bioguide ids, so the bioguide-keyed `memberVotes` field
 * stays empty for Senate rolls (shared contract, promoted in ticket 11).
 */
export function senateDetailToBillVote(detail: SenateRollCall, rollUrl: string): BillVote | undefined {
  if (detail.kind === "other") return undefined;
  return {
    type: detail.kind,
    chamber: "senate",
    date: detail.date,
    question: detail.question,
    result: mapSenateResult(detail.result),
    yea: detail.counts.yeas,
    nay: detail.counts.nays,
    present: detail.counts.present,
    notVoting: detail.counts.absent,
    rollUrl,
    byParty: detail.byParty,
    ...(detail.members.length > 0
      ? {
          senateMemberVotes: detail.members.map((m) => ({
            lisMemberId: m.lisMemberId,
            name: m.memberFull,
            party: m.party,
            state: m.state,
            vote: m.vote,
          })),
        }
      : {}),
  };
}

/** Menu-only fallback when the detail XML cannot be fetched (no party breakdown). */
export function senateMenuHitToBillVote(hit: SenateWatchHit): BillVote | undefined {
  if (hit.kind === "other") return undefined;
  return {
    type: hit.kind,
    chamber: "senate",
    date: hit.date,
    question: hit.question,
    result: mapSenateResult(hit.result),
    yea: hit.yeas ?? 0,
    nay: hit.nays ?? 0,
    rollUrl: hit.detailUrl,
  };
}
