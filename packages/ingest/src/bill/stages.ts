/**
 * Stage derivation from the BILLSTATUS action chronology plus Senate menu
 * watch hits, including the substitute / re-passage logic:
 *
 *  - The Senate text is an amendment in the nature of a substitute (ANS):
 *    a full strike-and-replace of the House-passed text. Senate passage of
 *    that substitute sets `requiresHouseRepassage` - it must NEVER be
 *    rendered as the bill becoming law.
 *  - Cloture (including cloture on the motion to proceed) never advances the
 *    "Senate floor vote" stage to done.
 *  - "Signed into law" is derived exclusively from an explicit became-law
 *    action - never inferred from passage votes.
 */
import type { BillStatusAction, BillStatusData, BillStatusTextVersion } from "./billstatus.js";
import { isEngrossedSenateAmendment } from "./billstatus.js";
import type { SenateWatchHit } from "./senateVotes.js";
import type { BillStage } from "./types.js";

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export interface Milestone {
  date: string;
  detail: string;
}

export interface BillMilestones {
  introduced: Milestone | undefined;
  housePassed: Milestone | undefined;
  receivedInSenate: Milestone | undefined;
  senateCommitteeReported: Milestone | undefined;
  senateCloture: Milestone | undefined;
  senatePassed: Milestone | undefined;
  houseRepassed: Milestone | undefined;
  toPresident: Milestone | undefined;
  becameLaw: Milestone | undefined;
  /** A strike-and-replace substitute (ANS) is the operative Senate text. */
  substituteInPlay: boolean;
  /**
   * True once the Senate has passed its substitute text and the House has not
   * yet re-passed it. While true, the bill can never be presented as law.
   */
  requiresHouseRepassage: boolean;
}

const SUBSTITUTE_RE = /amendment in the nature of a substitute/i;

function oldestFirst(actions: BillStatusAction[]): BillStatusAction[] {
  return [...actions].sort((a, b) => a.date.localeCompare(b.date));
}

function findAction(
  actions: BillStatusAction[],
  predicate: (a: BillStatusAction) => boolean,
): BillStatusAction | undefined {
  // Actions are scanned oldest-first so we report the first occurrence.
  return oldestFirst(actions).find(predicate);
}

function toMilestone(action: BillStatusAction | undefined): Milestone | undefined {
  return action === undefined ? undefined : { date: action.date, detail: action.text };
}

export function deriveMilestones(
  status: BillStatusData,
  senateHits: SenateWatchHit[] = [],
): BillMilestones {
  const { actions, textVersions } = status;

  const introduced =
    toMilestone(
      findAction(actions, (a) => a.actionCode === "1000" || /^introduced in house$/i.test(a.text)),
    ) ?? { date: status.introducedDate, detail: "Introduced" };

  const housePassed = toMilestone(
    findAction(actions, (a) => a.actionCode === "8000" || /passed\/agreed to in house/i.test(a.text)),
  );

  const receivedInSenate = toMilestone(findAction(actions, (a) => /received in the senate/i.test(a.text)));

  // Senate committee report: only actions after the bill reached the Senate.
  const senateStart = receivedInSenate?.date ?? "9999-12-31";
  const senateCommitteeActions = actions.filter((a) => a.date >= senateStart);
  const senateReported = findAction(
    senateCommitteeActions,
    (a) => a.actionCode === "14000" || /^committee on .*reported by senator/i.test(a.text),
  );
  const senateOrderedReported = findAction(senateCommitteeActions, (a) =>
    /ordered to be reported/i.test(a.text),
  );
  const senateCommitteeReported = toMilestone(senateReported ?? senateOrderedReported);

  // Substitute detection: committee report text mentioning an ANS, or a
  // senate-side text version that is itself the substitute (RS / EAS).
  const substituteFromActions = senateCommitteeActions.some((a) => SUBSTITUTE_RE.test(a.text));
  const substituteFromText = textVersions.some(
    (v) => v.chamber === "senate" && (v.code === "RS" || isEngrossedSenateAmendment(v.code)),
  );
  const substituteInPlay = substituteFromActions || substituteFromText;

  // --- Senate floor ---------------------------------------------------------
  // Cloture: from actions or the vote menu. Never counts as passage.
  const clotureAction = findAction(actions, (a) => /cloture/i.test(a.text));
  const clotureHit = senateHits.find((h) => h.kind === "cloture");
  const senateCloture =
    toMilestone(clotureAction) ??
    (clotureHit === undefined
      ? undefined
      : {
          date: clotureHit.date,
          detail: `${clotureHit.question}: ${clotureHit.result} (Roll no. ${clotureHit.voteNumber}).`,
        });

  // Senate passage: an explicit passed-in-Senate action, a passage roll call
  // in the vote menu, or the appearance of the EAS (Engrossed Amendment
  // Senate) text version. Cloture hits are excluded by construction.
  const senatePassedAction = findAction(
    actions,
    (a) => a.actionCode === "17000" || /passed\/agreed to in senate/i.test(a.text) || /passed senate/i.test(a.text),
  );
  const passageHit = senateHits.find((h) => h.kind === "passage" && isPassed(h.result));
  const easVersion: BillStatusTextVersion | undefined = textVersions.find((v) =>
    isEngrossedSenateAmendment(v.code),
  );
  const senatePassed =
    toMilestone(senatePassedAction) ??
    (passageHit !== undefined
      ? {
          date: passageHit.date,
          detail: `${passageHit.question}: ${passageHit.result}${
            passageHit.yeas !== undefined && passageHit.nays !== undefined
              ? ` ${passageHit.yeas}-${passageHit.nays}`
              : ""
          } (Roll no. ${passageHit.voteNumber}).`,
        }
      : easVersion !== undefined
        ? { date: easVersion.date, detail: "Engrossed Amendment Senate (EAS) text published." }
        : undefined);

  // Senate passage with a substitute in play (or via EAS, which is by
  // definition an amendment) means the amended text goes BACK to the House.
  const senatePassedSubstitute =
    senatePassed !== undefined && (substituteInPlay || easVersion !== undefined);

  const houseRepassed = toMilestone(
    findAction(
      actions,
      (a) =>
        /house agreed to (the )?senate amendment/i.test(a.text) ||
        (/motion that the house agree/i.test(a.text) && /senate amendment/i.test(a.text) && /agreed to/i.test(a.text)),
    ),
  );

  const toPresident = toMilestone(findAction(actions, (a) => /presented to president/i.test(a.text)));

  const becameLaw = toMilestone(
    findAction(actions, (a) => a.type === "BecameLaw" || /became public law/i.test(a.text)),
  );

  return {
    introduced,
    housePassed,
    receivedInSenate,
    senateCommitteeReported,
    senateCloture,
    senatePassed,
    houseRepassed,
    toPresident,
    becameLaw,
    substituteInPlay,
    requiresHouseRepassage: senatePassedSubstitute && houseRepassed === undefined,
  };
}

function isPassed(result: string): boolean {
  const r = result.toLowerCase();
  return r.includes("passed") || r.includes("agreed");
}

// ---------------------------------------------------------------------------
// Stage strip
// ---------------------------------------------------------------------------

function detailOrNone(m: Milestone | undefined): { detail?: string } {
  return m !== undefined && m.detail !== "" ? { detail: m.detail } : {};
}

/**
 * Build the fixed six-stage strip. Statuses: everything reached is "done",
 * the first unreached stage is "current", the rest are "pending". The
 * "Senate floor vote" stage stays current through cloture; only actual
 * passage completes it. "Signed into law" completes only on a became-law
 * action.
 */
export function buildStages(m: BillMilestones): BillStage[] {
  const senateFloorDetail = (): string | undefined => {
    if (m.senatePassed !== undefined) return m.senatePassed.detail;
    if (m.senateCloture !== undefined) {
      return `Cloture activity recorded - not a passage vote. ${m.senateCloture.detail}`;
    }
    return undefined;
  };

  const repassageDetail = (): string => {
    if (m.requiresHouseRepassage) {
      return "REQUIRED NOW: the Senate passed a strike-and-replace substitute, so the amended text goes back to the House. Senate passage did not make the House-passed CLARITY text law.";
    }
    return "Required because the Senate text strikes all House-passed text.";
  };

  const floorDetail = senateFloorDetail();

  const template: Array<{ label: string; milestone: Milestone | undefined; extra?: { detail?: string } }> = [
    { label: "Introduced in House", milestone: m.introduced },
    { label: "Passed House", milestone: m.housePassed },
    {
      label: m.substituteInPlay
        ? "Senate committee reported (substitute text)"
        : "Senate committee reported",
      milestone: m.senateCommitteeReported,
    },
    {
      label: "Senate floor vote",
      milestone: m.senatePassed,
      extra: floorDetail === undefined ? {} : { detail: floorDetail },
    },
    ...(m.substituteInPlay
      ? [
          {
            label: "House re-passage of Senate text",
            milestone: m.houseRepassed,
            extra: { detail: repassageDetail() },
          },
        ]
      : [{ label: "To President", milestone: m.toPresident }]),
    { label: "Signed into law", milestone: m.becameLaw },
  ];

  const stages: BillStage[] = [];
  let currentAssigned = false;
  for (const step of template) {
    const done = step.milestone !== undefined;
    let status: BillStage["status"];
    if (done) {
      status = "done";
    } else if (!currentAssigned) {
      status = "current";
      currentAssigned = true;
    } else {
      status = "pending";
    }
    const detail = step.extra?.detail !== undefined ? { detail: step.extra.detail } : detailOrNone(step.milestone);
    stages.push({
      label: step.label,
      date: step.milestone?.date ?? null,
      status,
      ...detail,
    });
  }
  return stages;
}
