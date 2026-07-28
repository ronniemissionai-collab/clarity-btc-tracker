/**
 * Logic tests (no network): stage derivation, vote typing (cloture !=
 * passage), substitute / re-passage state, the Senate-menu watcher with a
 * synthetic "cloture on H.R. 3633 appears in the menu" case, and the
 * end-to-end refresh over stubbed fetches.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isBill } from "@clarity-btc/shared";
import {
  BILLSTATUS_URL,
  assertNeverLawWithoutEnactment,
  buildStages,
  classifySenateQuestion,
  deriveMilestones,
  findBillVotesInMenu,
  houseRollToBillVote,
  parseBillStatus,
  parseHouseRoll,
  parseSenateVoteDetail,
  parseSenateVoteMenu,
  refreshBill,
  refreshBillDetailed,
  senateDetailToBillVote,
  senateVoteMenuUrl,
} from "../src/bill/index.js";
import type { BillStatusData, FetchText, SenateWatchHit } from "../src/bill/index.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/bill/${name}`, import.meta.url), "utf-8");

const billstatusXml = fixture("billstatus-119hr3633.xml");
const houseRollXml = fixture("house-roll199.xml");
const senateMenuXml = fixture("senate-vote-menu-119-2.xml");

const HOUSE_ROLL_URL = "https://clerk.house.gov/evs/2025/roll199.xml";
const AS_OF = "2026-07-28";

// ---------------------------------------------------------------------------
// Synthetic Senate XML builders
// ---------------------------------------------------------------------------

interface SyntheticVote {
  voteNumber: number;
  date: string; // menu format, e.g. "28-Jul"
  question: string;
  result: string;
  yeas: number;
  nays: number;
  title: string;
}

/** Inject a synthetic H.R. 3633 roll call at the top of the real (trimmed) menu. */
function menuWith(vote: SyntheticVote): string {
  const block = `    <vote>
      <vote_number>${String(vote.voteNumber).padStart(5, "0")}</vote_number>
      <vote_date>${vote.date}</vote_date>
      <issue>H.R. 3633</issue>
      <question>${vote.question}
         </question>
      <result>${vote.result}</result>
      <vote_tally>
        <yeas>${vote.yeas}</yeas>
        <nays>${vote.nays}</nays>
      </vote_tally>
      <title>${vote.title}</title>
    </vote>
`;
  return senateMenuXml.replace("<votes>\n", `<votes>\n${block}`);
}

/** Minimal but structurally faithful LIS vote-detail document. */
function detailXml(vote: SyntheticVote, isoDate: string, resultText: string): string {
  const member = (last: string, first: string, party: string, state: string, cast: string, lis: string): string => `
    <member>
      <member_full>${last} (${party}-${state})</member_full>
      <last_name>${last}</last_name>
      <first_name>${first}</first_name>
      <party>${party}</party>
      <state>${state}</state>
      <vote_cast>${cast}</vote_cast>
      <lis_member_id>${lis}</lis_member_id>
    </member>`;
  return `<?xml version="1.0" encoding="UTF-8"?><roll_call_vote>
  <congress>119</congress>
  <session>2</session>
  <congress_year>2026</congress_year>
  <vote_number>${vote.voteNumber}</vote_number>
  <vote_date>${isoDate}</vote_date>
  <question>${vote.question}</question>
  <vote_result>${resultText}</vote_result>
  <count>
    <yeas>${vote.yeas}</yeas>
    <nays>${vote.nays}</nays>
    <present/>
    <absent>${100 - vote.yeas - vote.nays}</absent>
  </count>
  <members>${member("Thune", "John", "R", "SD", "Yea", "S303")}${member("Scott", "Tim", "R", "SC", "Yea", "S365")}${member("Warner", "Mark", "D", "VA", "Nay", "S327")}${member("Alsobrooks", "Angela", "D", "MD", "Not Voting", "S428")}
  </members>
</roll_call_vote>`;
}

function stubFetch(overrides: Record<string, string>): FetchText {
  const routes: Record<string, string> = {
    [BILLSTATUS_URL]: billstatusXml,
    [HOUSE_ROLL_URL]: houseRollXml,
    [senateVoteMenuUrl(119, 2)]: senateMenuXml,
    ...overrides,
  };
  return (url: string): Promise<string> => {
    const body = routes[url];
    if (body === undefined) return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
    return Promise.resolve(body);
  };
}

const DETAIL_211_URL =
  "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00211.xml";

// ---------------------------------------------------------------------------
// Vote typing: cloture must never map to passage
// ---------------------------------------------------------------------------

describe("Senate question classification", () => {
  it("cloture questions are cloture, never passage", () => {
    expect(classifySenateQuestion("On the Cloture Motion")).toBe("cloture");
    expect(classifySenateQuestion("On Cloture on the Motion to Proceed")).toBe("cloture");
    expect(
      classifySenateQuestion(
        "On the Cloture Motion (Motion to Invoke Cloture: H.R. 3633)",
      ),
    ).toBe("cloture");
  });

  it("passage questions are passage", () => {
    expect(classifySenateQuestion("On Passage of the Bill")).toBe("passage");
    expect(classifySenateQuestion("On the Joint Resolution")).toBe("passage");
  });

  it("procedural questions are other", () => {
    expect(classifySenateQuestion("On the Motion to Proceed")).toBe("other");
    expect(classifySenateQuestion("On the Nomination")).toBe("other");
    expect(classifySenateQuestion("On the Motion to Table")).toBe("other");
    expect(classifySenateQuestion("On the Amendment")).toBe("other");
  });

  it("an agreed-to cloture detail converts to a BillVote typed cloture", () => {
    const vote: SyntheticVote = {
      voteNumber: 211,
      date: "28-Jul",
      question: "On the Cloture Motion",
      result: "Agreed to",
      yeas: 60,
      nays: 40,
      title: "Motion to Invoke Cloture: H.R. 3633",
    };
    const detail = parseSenateVoteDetail(detailXml(vote, "July 28, 2026,  02:15 PM", "Cloture Motion Agreed to"));
    const billVote = senateDetailToBillVote(detail, DETAIL_211_URL);
    expect(billVote?.type).toBe("cloture");
    expect(billVote?.type).not.toBe("passage");
    expect(billVote?.result).toBe("passed"); // the motion carried - but it is still only cloture
    expect(billVote?.chamber).toBe("senate");
    expect(billVote?.rollUrl).toBe(DETAIL_211_URL);
    expect(billVote?.byParty?.["R"]).toEqual({ yea: 2, nay: 0, present: 0, notVoting: 0 });
    expect(billVote?.byParty?.["D"]).toEqual({ yea: 0, nay: 1, present: 0, notVoting: 1 });
  });
});

// ---------------------------------------------------------------------------
// Stage derivation + substitute logic over the real BILLSTATUS fixture
// ---------------------------------------------------------------------------

describe("milestones and stages from the real BILLSTATUS fixture", () => {
  const status = parseBillStatus(billstatusXml);
  const milestones = deriveMilestones(status);

  it("derives the verified chronology", () => {
    expect(milestones.introduced?.date).toBe("2025-05-29");
    expect(milestones.housePassed?.date).toBe("2025-07-17");
    expect(milestones.receivedInSenate?.date).toBe("2025-09-18");
    expect(milestones.senateCommitteeReported?.date).toBe("2026-06-01");
  });

  it("detects the Senate substitute (ANS) from the committee report", () => {
    expect(milestones.substituteInPlay).toBe(true);
  });

  it("has no Senate passage and no re-passage requirement yet", () => {
    expect(milestones.senatePassed).toBeUndefined();
    expect(milestones.senateCloture).toBeUndefined();
    expect(milestones.requiresHouseRepassage).toBe(false);
    expect(milestones.becameLaw).toBeUndefined();
  });

  it("builds the six-stage strip with 'Senate floor vote' current", () => {
    const stages = buildStages(milestones);
    expect(stages.map((s) => s.label)).toEqual([
      "Introduced in House",
      "Passed House",
      "Senate committee reported (substitute text)",
      "Senate floor vote",
      "House re-passage of Senate text",
      "Signed into law",
    ]);
    expect(stages.map((s) => s.status)).toEqual([
      "done",
      "done",
      "done",
      "current",
      "pending",
      "pending",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Synthetic case: a Senate cloture vote on H.R. 3633 appears in the menu
// ---------------------------------------------------------------------------

describe("synthetic: Senate cloture on H.R. 3633 appears in the vote menu", () => {
  const cloture: SyntheticVote = {
    voteNumber: 211,
    date: "28-Jul",
    question: "On the Cloture Motion",
    result: "Agreed to",
    yeas: 60,
    nays: 40,
    title: "Motion to Invoke Cloture: H.R. 3633; Digital Asset Market Clarity Act",
  };
  const menu = parseSenateVoteMenu(menuWith(cloture));

  it("the watcher detects the new vote and types it cloture", () => {
    const hits = findBillVotesInMenu(menu, "H.R. 3633");
    expect(hits.length).toBe(1);
    const hit = hits[0] as SenateWatchHit;
    expect(hit.voteNumber).toBe(211);
    expect(hit.kind).toBe("cloture");
    expect(hit.date).toBe("2026-07-28");
    expect(hit.detailUrl).toBe(DETAIL_211_URL);
  });

  it("cloture keeps 'Senate floor vote' current and sets no re-passage state", async () => {
    const result = await refreshBillDetailed({
      fetchText: stubFetch({
        [senateVoteMenuUrl(119, 2)]: menuWith(cloture),
        [DETAIL_211_URL]: detailXml(cloture, "July 28, 2026,  02:15 PM", "Cloture Motion Agreed to"),
      }),
      asOf: AS_OF,
    });

    expect(result.warnings).toEqual([]);
    expect(result.senateWatch.map((h) => h.voteNumber)).toEqual([211]);

    // The cloture vote enters votes[] typed cloture - never passage.
    const senateVotes = result.bill.votes.filter((v) => v.chamber === "senate");
    expect(senateVotes.length).toBe(1);
    expect(senateVotes[0]?.type).toBe("cloture");
    expect(result.bill.votes.some((v) => v.chamber === "senate" && v.type === "passage")).toBe(false);

    // Milestones: cloture recorded, but no Senate passage, no re-passage, no law.
    expect(result.milestones.senateCloture?.date).toBe("2026-07-28");
    expect(result.milestones.senatePassed).toBeUndefined();
    expect(result.milestones.requiresHouseRepassage).toBe(false);

    const stageByLabel = new Map(result.bill.stages.map((s) => [s.label, s]));
    expect(stageByLabel.get("Senate floor vote")?.status).toBe("current");
    expect(stageByLabel.get("Senate floor vote")?.detail).toContain("not a passage vote");
    expect(stageByLabel.get("House re-passage of Senate text")?.status).toBe("pending");
    expect(stageByLabel.get("Signed into law")?.status).toBe("pending");

    // The menu beat BILLSTATUS: the roll call surfaces as the latest action.
    expect(result.bill.latestAction.date).toBe("2026-07-28");
    expect(result.bill.latestAction.text).toContain("On the Cloture Motion");
  });
});

// ---------------------------------------------------------------------------
// Substitute logic: Senate passage of the substitute is never "law"
// ---------------------------------------------------------------------------

describe("Senate passage of the substitute text", () => {
  const passage: SyntheticVote = {
    voteNumber: 212,
    date: "29-Jul",
    question: "On Passage of the Bill",
    result: "Passed",
    yeas: 62,
    nays: 38,
    title: "H.R. 3633; Digital Asset Market Clarity Act",
  };
  const DETAIL_212_URL =
    "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00212.xml";

  async function refreshWithSenatePassage() {
    return refreshBillDetailed({
      fetchText: stubFetch({
        [senateVoteMenuUrl(119, 2)]: menuWith(passage),
        [DETAIL_212_URL]: detailXml(passage, "July 29, 2026,  05:40 PM", "Bill Passed"),
      }),
      asOf: AS_OF,
    });
  }

  it("sets requiresHouseRepassage - and never renders law", async () => {
    const result = await refreshWithSenatePassage();

    expect(result.milestones.senatePassed?.date).toBe("2026-07-29");
    expect(result.milestones.substituteInPlay).toBe(true);
    expect(result.milestones.requiresHouseRepassage).toBe(true);
    expect(result.milestones.becameLaw).toBeUndefined();

    const stageByLabel = new Map(result.bill.stages.map((s) => [s.label, s]));
    expect(stageByLabel.get("Senate floor vote")?.status).toBe("done");
    expect(stageByLabel.get("House re-passage of Senate text")?.status).toBe("current");
    expect(stageByLabel.get("House re-passage of Senate text")?.detail).toContain("did not make");
    expect(stageByLabel.get("Signed into law")?.status).toBe("pending");

    // The substitute warning escalates and says explicitly: NOT law.
    expect(result.bill.substituteWarning).toContain("NOT law");
    expect(result.bill.substituteWarning).toContain("re-passage");

    // The senate vote is typed passage but the invariant guard still holds.
    const senatePassage = result.bill.votes.find((v) => v.chamber === "senate" && v.type === "passage");
    expect(senatePassage?.result).toBe("passed");
    expect(() =>
      assertNeverLawWithoutEnactment({ bill: result.bill, milestones: result.milestones }),
    ).not.toThrow();
  });

  it("EAS (Engrossed Amendment Senate) text version alone flags substitute passage", () => {
    const status = parseBillStatus(billstatusXml);
    const withEas: BillStatusData = {
      ...status,
      textVersions: [
        {
          code: "EAS",
          type: "Engrossed Amendment Senate",
          chamber: "senate",
          date: "2026-07-29",
          url: "https://www.govinfo.gov/content/pkg/BILLS-119hr3633eas/xml/BILLS-119hr3633eas.xml",
        },
        ...status.textVersions,
      ],
    };
    const milestones = deriveMilestones(withEas);
    expect(milestones.senatePassed?.date).toBe("2026-07-29");
    expect(milestones.requiresHouseRepassage).toBe(true);
    const stages = buildStages(milestones);
    expect(stages.find((s) => s.label === "Signed into law")?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// End-to-end refresh over the real fixtures (stubbed fetch, no network)
// ---------------------------------------------------------------------------

describe("refreshBillDetailed over the real fixtures", () => {
  it("assembles a schema-valid Bill matching the verified 2026-07 state", async () => {
    const result = await refreshBillDetailed({ fetchText: stubFetch({}), asOf: AS_OF });
    const bill = result.bill;

    expect(isBill(bill)).toBe(true);
    expect(bill.congress).toBe(119);
    expect(bill.billType).toBe("hr");
    expect(bill.number).toBe(3633);
    expect(bill.shortTitle).toBe("CLARITY Act");
    expect(bill.asOf).toBe(AS_OF);

    // Exactly one vote so far: House passage with the full member breakdown.
    expect(bill.votes.length).toBe(1);
    expect(bill.votes[0]?.type).toBe("passage");
    expect(bill.votes[0]?.chamber).toBe("house");
    expect(bill.votes[0]?.yea).toBe(294);
    expect(bill.votes[0]?.memberVotes?.length).toBe(432);

    // Substitute warning present; latest action is the calendar placement.
    expect(bill.substituteWarning).toContain("strike-and-replace");
    expect(bill.latestAction.date).toBe("2026-06-01");

    // Text versions carry the house-passed vs senate-substitute distinction.
    const versions = bill.textVersions.map((v) => v.version);
    expect(versions).toContain("EH");
    expect(versions).toContain("RS");
    const rs = bill.textVersions.find((v) => v.version === "RS");
    expect(rs?.label).toContain("substitute");

    // Related-bills watch list survives into the contract.
    expect(bill.relatedBills.length).toBe(3);
    expect(result.senateWatch).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("houseRollToBillVote is wired from the BILLSTATUS recordedVotes reference", async () => {
    // Sanity: the module found the roll via BILLSTATUS, not a hardcoded URL.
    const status = parseBillStatus(billstatusXml);
    const urls = status.actions.flatMap((a) => a.recordedVotes.map((r) => r.url));
    expect(urls).toContain(HOUSE_ROLL_URL);
    const roll = parseHouseRoll(houseRollXml);
    expect(houseRollToBillVote(roll, HOUSE_ROLL_URL)?.type).toBe("passage");
  });

  it("refreshBill returns null (keep last good data) when a source fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: FetchText = () => Promise.reject(new Error("network down"));
    await expect(refreshBill({ fetchText: failing })).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
