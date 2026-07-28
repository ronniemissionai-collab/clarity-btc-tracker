/**
 * Assemble the shared Bill entity from parsed sources. The output is always
 * validated through the shared zod contract (parseBill) before it is returned,
 * so data/bill.json can never drift from packages/shared.
 */
import type { Bill } from "@clarity-btc/shared";
import { parseBill } from "@clarity-btc/shared";
import type { BillStatusData, BillStatusTextVersion } from "./billstatus.js";
import type { BillMilestones } from "./stages.js";
import { buildStages, deriveMilestones } from "./stages.js";
import type { SenateWatchHit } from "./senateVotes.js";
import type { BillTextVersion, BillVote, RelatedBill } from "./types.js";

// ---------------------------------------------------------------------------
// Text versions (house-passed vs senate-substitute labeling)
// ---------------------------------------------------------------------------

const VERSION_LABELS: Record<string, string> = {
  IH: "Introduced in House",
  RH: "Reported in House",
  EH: "Engrossed in House (House-passed text)",
  RFS: "Referred in Senate (House-passed text as received)",
  RS: "Reported to Senate - committee amendment in the nature of a substitute (strike-and-replace)",
  EAS: "Engrossed Amendment Senate - the Senate-passed substitute text (NOT the House-passed text)",
  EAH: "Engrossed Amendment House",
  ENR: "Enrolled Bill",
};

export function toBillTextVersion(v: BillStatusTextVersion): BillTextVersion {
  const label = VERSION_LABELS[v.code] ?? v.type;
  return {
    version: v.code,
    label,
    ...(v.chamber !== undefined ? { chamber: v.chamber } : {}),
    date: v.date,
    url: v.url,
  };
}

// ---------------------------------------------------------------------------
// Related-bills watch list (new-vehicle risk)
// ---------------------------------------------------------------------------

/** Titles that look like a replacement Senate market-structure vehicle. */
const VEHICLE_RISK_RE =
  /market structure|digital commodit|responsible financial innovation|clarity|digital asset/i;

export function toRelatedBills(status: BillStatusData): RelatedBill[] {
  return status.relatedBills.map((rb) => {
    const vehicleRisk = rb.type.toUpperCase().startsWith("S") && VEHICLE_RISK_RE.test(rb.title);
    return {
      title: rb.title,
      number: rb.label,
      url: rb.url,
      ...(vehicleRisk
        ? {
            note: "WATCH: Senate-side measure matching market-structure keywords - possible replacement vehicle for the CLARITY text.",
          }
        : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Substitute warning copy
// ---------------------------------------------------------------------------

export function buildSubstituteWarning(m: BillMilestones): string | undefined {
  if (!m.substituteInPlay) return undefined;
  const base =
    "The Senate text is a full strike-and-replace substitute (amendment in the nature of a substitute). " +
    "If the Senate passes H.R. 3633, the bill goes back to the House for re-passage of the amended text - " +
    "it does NOT send the House-passed CLARITY text to the President. A cloture vote is not a passage vote.";
  if (m.requiresHouseRepassage) {
    return (
      "The Senate passed its substitute text - this is NOT the House-passed CLARITY text and it is NOT law. " +
      "House re-passage of the amended text is now required. " +
      base
    );
  }
  return base;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AssembleBillInput {
  status: BillStatusData;
  /** House roll-call votes already converted to the shared shape. */
  houseVotes: BillVote[];
  /** Senate roll-call votes already converted to the shared shape. */
  senateVotes: BillVote[];
  /** All menu hits on the bill (including procedural votes). */
  senateWatch: SenateWatchHit[];
  /** ISO date stamped on the output. */
  asOf: string;
  shortTitle?: string;
}

export interface AssembledBill {
  bill: Bill;
  milestones: BillMilestones;
}

export function assembleBill(input: AssembleBillInput): AssembledBill {
  const { status, senateWatch } = input;
  const milestones = deriveMilestones(status, senateWatch);
  const stages = buildStages(milestones);

  const votes = [...input.houseVotes, ...input.senateVotes].sort(
    (a, b) => a.date.localeCompare(b.date) || a.chamber.localeCompare(b.chamber),
  );

  // The Senate vote menu updates before BILLSTATUS does - surface the newest
  // roll call as the latest action when it postdates the official one.
  let latestAction = { date: status.latestAction.date, text: status.latestAction.text };
  const newestHit = senateWatch[senateWatch.length - 1];
  if (newestHit !== undefined && newestHit.date > latestAction.date) {
    latestAction = {
      date: newestHit.date,
      text: `Senate roll call ${newestHit.voteNumber}: ${newestHit.question} - ${newestHit.result}.`,
    };
  }

  const textVersions = [...status.textVersions]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(toBillTextVersion)
    .filter((v) => v.url !== "");

  const shortTitle = input.shortTitle ?? status.shortTitle;
  const warning = buildSubstituteWarning(milestones);

  const bill: Bill = parseBill({
    congress: status.congress,
    billType: status.billType,
    number: status.number,
    title: status.title,
    ...(shortTitle !== undefined ? { shortTitle } : {}),
    introducedDate: status.introducedDate,
    ...(status.sponsor !== undefined
      ? { sponsor: { name: status.sponsor.name, party: status.sponsor.party, state: status.sponsor.state } }
      : {}),
    latestAction,
    ...(warning !== undefined ? { substituteWarning: warning } : {}),
    requiresHouseRepassage: milestones.requiresHouseRepassage,
    stages,
    textVersions,
    votes,
    relatedBills: toRelatedBills(status),
    asOf: input.asOf,
  });

  return { bill, milestones };
}

/**
 * Guard used by tests and by the pipeline's validation gate: under no
 * combination of inputs may Senate passage of the substitute be presented as
 * the bill being law.
 */
export function assertNeverLawWithoutEnactment(assembled: AssembledBill): void {
  const lawStage = assembled.bill.stages.find((s) => s.label === "Signed into law");
  if (assembled.milestones.becameLaw === undefined && lawStage?.status === "done") {
    throw new Error(
      "invariant violated: 'Signed into law' marked done without an explicit became-law action",
    );
  }
  if (assembled.milestones.requiresHouseRepassage && lawStage?.status === "done") {
    throw new Error("invariant violated: bill rendered as law while House re-passage is required");
  }
}
