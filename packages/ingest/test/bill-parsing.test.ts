/**
 * Parsing tests over the saved real XML fixtures (no network):
 *  - GovInfo BILLSTATUS-119hr3633.xml (fetched live 2026-07-28)
 *  - House Clerk evs/2025/roll199.xml (CLARITY House passage)
 *  - Senate vote_menu_119_2.xml (trimmed from 210 to 22 representative votes)
 *  - Senate vote_119_2_00001.xml (real detail-format example)
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyTextVersion,
  findBillVotesInMenu,
  houseRollToBillVote,
  isHousePassedVersion,
  isSenateSubstituteVersion,
  parseBillStatus,
  parseHouseRoll,
  parseSenateVoteDetail,
  parseSenateVoteMenu,
  senateDetailToBillVote,
  senateVoteDetailUrl,
} from "../src/bill/index.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/bill/${name}`, import.meta.url), "utf-8");

const billstatusXml = fixture("billstatus-119hr3633.xml");
const houseRollXml = fixture("house-roll199.xml");
const senateMenuXml = fixture("senate-vote-menu-119-2.xml");
const senateDetailXml = fixture("senate-vote-119-2-00001.xml");

describe("GovInfo BILLSTATUS parsing", () => {
  const status = parseBillStatus(billstatusXml);

  it("identifies the bill", () => {
    expect(status.congress).toBe(119);
    expect(status.billType).toBe("hr");
    expect(status.number).toBe(3633);
    expect(status.title).toBe("Digital Asset Market Clarity Act");
    expect(status.introducedDate).toBe("2025-05-29");
  });

  it("parses the sponsor", () => {
    expect(status.sponsor).toEqual({
      bioguideId: "H001072",
      name: "Rep. J. French Hill",
      party: "R",
      state: "AR",
    });
  });

  it("parses the latest action (calendar placement, 2026-06-01)", () => {
    expect(status.latestAction.date).toBe("2026-06-01");
    expect(status.latestAction.text).toContain("Calendar No. 423");
  });

  it("parses the full action chronology", () => {
    expect(status.actions.length).toBe(28);
    const dates = status.actions.map((a) => a.date);
    expect(dates).toContain("2025-05-29"); // introduced
    expect(dates).toContain("2025-07-17"); // House passage
    expect(dates).toContain("2026-05-14"); // Senate Banking ordered reported (ANS)
  });

  it("extracts the House roll-call reference from recordedVotes", () => {
    const refs = status.actions.flatMap((a) => a.recordedVotes);
    expect(refs.length).toBeGreaterThan(0);
    const roll199 = refs.find((r) => r.rollNumber === 199);
    expect(roll199?.url).toBe("https://clerk.house.gov/evs/2025/roll199.xml");
    expect(roll199?.chamber).toBe("house");
    expect(roll199?.date).toBe("2025-07-17");
  });

  it("parses text versions and distinguishes house-passed vs senate-substitute", () => {
    const codes = status.textVersions.map((v) => v.code);
    expect(codes).toContain("IH");
    expect(codes).toContain("EH"); // engrossed House-passed text
    expect(codes).toContain("RS"); // reported to Senate with the committee substitute
    const eh = status.textVersions.find((v) => v.code === "EH");
    expect(eh?.chamber).toBe("house");
    expect(eh?.date).toBe("2025-07-17");
    expect(eh?.url).toContain("BILLS-119hr3633eh");
    const rs = status.textVersions.find((v) => v.code === "RS");
    expect(rs?.chamber).toBe("senate");
    expect(isHousePassedVersion("EH")).toBe(true);
    expect(isSenateSubstituteVersion("RS")).toBe(true);
    expect(isSenateSubstituteVersion("EAS")).toBe(true);
    expect(isSenateSubstituteVersion("EH")).toBe(false);
  });

  it("classifies the EAS (Engrossed Amendment Senate) version type", () => {
    expect(classifyTextVersion("Engrossed Amendment Senate")).toEqual({
      code: "EAS",
      chamber: "senate",
    });
  });

  it("builds the relatedBills watch list with congress.gov URLs", () => {
    expect(status.relatedBills.length).toBe(3);
    const sifr = status.relatedBills.find((rb) => rb.label === "H.R. 3690");
    expect(sifr?.title).toBe("Securing Innovation in Financial Regulation Act");
    expect(sifr?.url).toBe("https://www.congress.gov/bill/119th-congress/house-bill/3690");
    // The enormous rules-resolution title is truncated to a sane length.
    for (const rb of status.relatedBills) {
      expect(rb.title.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("House Clerk EVS roll parsing (roll 199, CLARITY passage)", () => {
  const roll = parseHouseRoll(houseRollXml);

  it("parses the metadata", () => {
    expect(roll.congress).toBe(119);
    expect(roll.rollNumber).toBe(199);
    expect(roll.legisNum).toBe("H R 3633");
    expect(roll.question).toBe("On Passage");
    expect(roll.result).toBe("Passed");
    expect(roll.date).toBe("2025-07-17");
  });

  it("parses the verified totals: 294-134, 0 present, 4 not voting", () => {
    expect(roll.totals).toEqual({ yea: 294, nay: 134, present: 0, notVoting: 4 });
  });

  it("parses the party breakdown: R 216-0, D 78-134", () => {
    expect(roll.byParty["R"]).toEqual({ yea: 216, nay: 0, present: 0, notVoting: 4 });
    expect(roll.byParty["D"]).toEqual({ yea: 78, nay: 134, present: 0, notVoting: 0 });
  });

  it("parses all 432 per-member votes with bioguide ids", () => {
    expect(roll.members.length).toBe(432);
    const aderholt = roll.members.find((m) => m.bioguideId === "A000055");
    expect(aderholt?.vote).toBe("yea");
    expect(aderholt?.party).toBe("R");
    const adams = roll.members.find((m) => m.bioguideId === "A000370");
    expect(adams?.vote).toBe("nay");
  });

  it("member votes reconcile with the printed totals", () => {
    const count = (v: string): number => roll.members.filter((m) => m.vote === v).length;
    expect(count("yea")).toBe(294);
    expect(count("nay")).toBe(134);
    expect(count("present")).toBe(0);
    // 4 not-voting members are listed too (432 voting + 4 = 436 seats incl. vacancies).
    expect(count("not-voting")).toBe(4);
  });

  it("converts to a shared BillVote typed as passage with per-member breakdown", () => {
    const vote = houseRollToBillVote(roll, "https://clerk.house.gov/evs/2025/roll199.xml");
    expect(vote).toBeDefined();
    expect(vote?.type).toBe("passage");
    expect(vote?.chamber).toBe("house");
    expect(vote?.result).toBe("passed");
    expect(vote?.yea).toBe(294);
    expect(vote?.nay).toBe(134);
    expect(vote?.rollUrl).toBe("https://clerk.house.gov/evs/2025/roll199.xml");
    expect(vote?.memberVotes?.length).toBe(432);
  });
});

describe("Senate vote menu parsing (trimmed 119-2 menu)", () => {
  const menu = parseSenateVoteMenu(senateMenuXml);

  it("parses the session header", () => {
    expect(menu.congress).toBe(119);
    expect(menu.session).toBe(2);
    expect(menu.congressYear).toBe(2026);
    expect(menu.votes.length).toBe(22);
  });

  it("resolves menu dates (day-month only) against the congress year", () => {
    const newest = menu.votes[0];
    expect(newest?.voteNumber).toBe(210);
    expect(newest?.date).toBe("2026-07-27");
  });

  it("classifies questions: cloture stays cloture, passage stays passage", () => {
    const v210 = menu.votes.find((v) => v.voteNumber === 210);
    expect(v210?.kind).toBe("cloture");
    const v163 = menu.votes.find((v) => v.voteNumber === 163);
    expect(v163?.question).toBe("On Passage of the Bill");
    expect(v163?.kind).toBe("passage");
    const v44 = menu.votes.find((v) => v.voteNumber === 44);
    expect(v44?.question).toBe("On Cloture on the Motion to Proceed");
    expect(v44?.kind).toBe("cloture");
    const v4 = menu.votes.find((v) => v.voteNumber === 4);
    expect(v4?.kind).toBe("other"); // plain motion to proceed
  });

  it("parses en-bloc matters (vote 125)", () => {
    const enBloc = menu.votes.find((v) => v.voteNumber === 125);
    expect(enBloc?.enBlocIssues.length).toBeGreaterThan(0);
    expect(enBloc?.enBlocIssues).toContain("PN726-1");
  });

  it("finds no H.R. 3633 votes in the real menu (verified state as of fetch)", () => {
    expect(findBillVotesInMenu(menu, "H.R. 3633")).toEqual([]);
  });

  it("finds the H.R. 6644 trajectory: cloture-on-MTP then passage, oldest first", () => {
    const hits = findBillVotesInMenu(menu, "H.R. 6644");
    expect(hits.map((h) => h.voteNumber)).toEqual([44, 53]);
    expect(hits[0]?.kind).toBe("cloture");
    expect(hits[1]?.kind).toBe("passage");
    expect(hits[1]?.detailUrl).toBe(
      "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00053.xml",
    );
  });

  it("matches issue formats loosely (H.R. 6644 / hr6644 / H R 6644)", () => {
    expect(findBillVotesInMenu(menu, "hr6644").length).toBe(2);
    expect(findBillVotesInMenu(menu, "H R 6644").length).toBe(2);
  });

  it("honors watcher state (seenVoteNumbers)", () => {
    const hits = findBillVotesInMenu(menu, "H.R. 6644", { seenVoteNumbers: [44] });
    expect(hits.map((h) => h.voteNumber)).toEqual([53]);
  });
});

describe("Senate vote detail parsing (real vote 119-2-1)", () => {
  const detail = parseSenateVoteDetail(senateDetailXml);

  it("parses the metadata and counts", () => {
    expect(detail.congress).toBe(119);
    expect(detail.session).toBe(2);
    expect(detail.voteNumber).toBe(1);
    expect(detail.date).toBe("2026-01-05");
    expect(detail.question).toBe("On the Nomination");
    expect(detail.counts).toEqual({ yeas: 50, nays: 35, present: 0, absent: 15 });
  });

  it("parses all 100 per-member votes", () => {
    expect(detail.members.length).toBe(100);
    const alsobrooks = detail.members.find((m) => m.lastName === "Alsobrooks");
    expect(alsobrooks?.vote).toBe("nay");
    expect(alsobrooks?.party).toBe("D");
    expect(alsobrooks?.state).toBe("MD");
    expect(alsobrooks?.lisMemberId).toBe("S428");
  });

  it("computes the party breakdown from the member list", () => {
    const total = Object.values(detail.byParty).reduce(
      (n, t) => n + t.yea + t.nay + (t.present ?? 0) + (t.notVoting ?? 0),
      0,
    );
    expect(total).toBe(100);
    expect((detail.byParty["R"]?.yea ?? 0) + (detail.byParty["D"]?.yea ?? 0) + (detail.byParty["I"]?.yea ?? 0)).toBe(50);
  });

  it("a nomination vote is 'other' and never becomes a Bill vote", () => {
    expect(detail.kind).toBe("other");
    expect(senateDetailToBillVote(detail, senateVoteDetailUrl(119, 2, 1))).toBeUndefined();
  });
});
