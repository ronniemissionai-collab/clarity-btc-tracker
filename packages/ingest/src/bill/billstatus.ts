/**
 * Parser for GovInfo bulk BILLSTATUS XML (keyless mirror of the Congress.gov
 * API), e.g. https://www.govinfo.gov/bulkdata/BILLSTATUS/119/hr/BILLSTATUS-119hr3633.xml
 *
 * Extracts the action chronology (the source of truth for stage derivation),
 * text versions (house-passed vs senate-substitute detection), recorded-vote
 * references (which Clerk / Senate LIS roll XMLs to fetch), sponsor, titles,
 * and the relatedBills watch list (new-vehicle risk).
 */
import type { Party } from "@clarity-btc/shared";
import { isoDateOnly } from "./dates.js";
import { child, children, childText, descend, parseXml } from "./xml.js";
import type { XmlElement } from "./xml.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordedVoteRef {
  rollNumber: number;
  chamber: "house" | "senate";
  congress: number;
  sessionNumber: number;
  /** ISO date (date part). */
  date: string;
  /** Machine-readable roll XML (clerk.house.gov EVS / senate.gov LIS). */
  url: string;
}

export interface BillStatusAction {
  /** ISO date. */
  date: string;
  text: string;
  type: string;
  actionCode: string;
  recordedVotes: RecordedVoteRef[];
}

export interface BillStatusTextVersion {
  /** Congress.gov version code: IH, RH, EH, RFS, RS, EAS, ENR, ... */
  code: string;
  /** BILLSTATUS type string, e.g. "Engrossed in House". */
  type: string;
  chamber: "house" | "senate" | undefined;
  /** ISO date. */
  date: string;
  url: string;
}

export interface BillStatusRelatedBill {
  title: string;
  congress: number;
  /** e.g. "H.R. 3690", "S. 2", "H.Res. 580". */
  label: string;
  type: string;
  number: string;
  url: string;
}

export interface BillStatusSponsor {
  bioguideId: string;
  name: string;
  party: Party;
  state: string;
}

export interface BillStatusData {
  congress: number;
  billType: string;
  number: number;
  title: string;
  shortTitle: string | undefined;
  introducedDate: string;
  sponsor: BillStatusSponsor | undefined;
  latestAction: { date: string; text: string };
  /** Newest first, exactly as BILLSTATUS orders them. */
  actions: BillStatusAction[];
  /** Newest first. */
  textVersions: BillStatusTextVersion[];
  relatedBills: BillStatusRelatedBill[];
}

// ---------------------------------------------------------------------------
// Text-version classification (house-passed vs senate-substitute)
// ---------------------------------------------------------------------------

interface VersionInfo {
  code: string;
  chamber: "house" | "senate" | undefined;
}

const TEXT_VERSION_CODES: Record<string, VersionInfo> = {
  "introduced in house": { code: "IH", chamber: "house" },
  "reported in house": { code: "RH", chamber: "house" },
  "engrossed in house": { code: "EH", chamber: "house" },
  "referred in senate": { code: "RFS", chamber: "senate" },
  "reported to senate": { code: "RS", chamber: "senate" },
  "engrossed amendment senate": { code: "EAS", chamber: "senate" },
  "engrossed amendment house": { code: "EAH", chamber: "house" },
  "enrolled bill": { code: "ENR", chamber: undefined },
  "public law": { code: "PL", chamber: undefined },
};

export function classifyTextVersion(type: string): VersionInfo {
  const known = TEXT_VERSION_CODES[type.trim().toLowerCase()];
  if (known !== undefined) return known;
  // Fallback: initials of the type string, chamber unknown.
  const code = type
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
  return { code: code.length > 0 ? code : "UNKNOWN", chamber: undefined };
}

/** The engrossed House-passed text. */
export function isHousePassedVersion(code: string): boolean {
  return code === "EH";
}

/**
 * Senate-side replacement text: RS carries the committee's amendment in the
 * nature of a substitute; EAS is the engrossed Senate amendment - its
 * appearance means the Senate passed its own (substitute) text.
 */
export function isSenateSubstituteVersion(code: string): boolean {
  return code === "RS" || code === "EAS";
}

/** EAS = Engrossed Amendment Senate: hard evidence of Senate passage of a substitute. */
export function isEngrossedSenateAmendment(code: string): boolean {
  return code === "EAS";
}

// ---------------------------------------------------------------------------
// Related-bill labeling
// ---------------------------------------------------------------------------

const BILL_TYPE_SLUGS: Record<string, { slug: string; label: string }> = {
  HR: { slug: "house-bill", label: "H.R." },
  S: { slug: "senate-bill", label: "S." },
  HRES: { slug: "house-resolution", label: "H.Res." },
  SRES: { slug: "senate-resolution", label: "S.Res." },
  HJRES: { slug: "house-joint-resolution", label: "H.J.Res." },
  SJRES: { slug: "senate-joint-resolution", label: "S.J.Res." },
  HCONRES: { slug: "house-concurrent-resolution", label: "H.Con.Res." },
  SCONRES: { slug: "senate-concurrent-resolution", label: "S.Con.Res." },
};

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function congressGovBillUrl(congress: number, type: string, number: string): string {
  const info = BILL_TYPE_SLUGS[type.toUpperCase()];
  const slug = info?.slug ?? "bill";
  return `https://www.congress.gov/bill/${ordinal(congress)}-congress/${slug}/${number}`;
}

export function billLabel(type: string, number: string): string {
  const info = BILL_TYPE_SLUGS[type.toUpperCase()];
  return info === undefined ? `${type} ${number}` : `${info.label} ${number}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseRecordedVotes(item: XmlElement): RecordedVoteRef[] {
  const holder = child(item, "recordedVotes");
  if (holder === undefined) return [];
  const refs: RecordedVoteRef[] = [];
  for (const rv of children(holder, "recordedVote")) {
    const chamberRaw = childText(rv, "chamber").toLowerCase();
    const chamber = chamberRaw === "senate" ? "senate" : "house";
    const url = childText(rv, "url");
    if (url === "") continue;
    refs.push({
      rollNumber: Number(childText(rv, "rollNumber")),
      chamber,
      congress: Number(childText(rv, "congress")),
      sessionNumber: Number(childText(rv, "sessionNumber")),
      date: isoDateOnly(childText(rv, "date")),
      url,
    });
  }
  return refs;
}

function parseSponsor(bill: XmlElement, billType: string): BillStatusSponsor | undefined {
  const item = descend(bill, "sponsors", "item");
  if (item === undefined) return undefined;
  const partyRaw = childText(item, "party");
  if (partyRaw !== "R" && partyRaw !== "D" && partyRaw !== "I") return undefined;
  const prefix = billType.toLowerCase().startsWith("s") ? "Sen." : "Rep.";
  const name = [childText(item, "firstName"), childText(item, "middleName"), childText(item, "lastName")]
    .filter((part) => part !== "")
    .join(" ");
  return {
    bioguideId: childText(item, "bioguideId"),
    name: `${prefix} ${name}`,
    party: partyRaw,
    state: childText(item, "state"),
  };
}

function parseShortTitle(bill: XmlElement): string | undefined {
  const titles = child(bill, "titles");
  if (titles === undefined) return undefined;
  const items = children(titles, "item");
  const shortTitles = items.filter((t) => childText(t, "titleType").startsWith("Short Title"));
  const preferred =
    shortTitles.find((t) => childText(t, "titleType").includes("as Introduced")) ?? shortTitles[0];
  const title = preferred === undefined ? "" : childText(preferred, "title");
  return title === "" ? undefined : title;
}

const RELATED_TITLE_MAX = 200;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function parseBillStatus(xmlText: string): BillStatusData {
  const root = parseXml(xmlText);
  const bill = root.name === "bill" ? root : child(root, "bill");
  if (bill === undefined) throw new Error("BILLSTATUS XML has no <bill> element");

  const billType = childText(bill, "type").toLowerCase();

  const actions: BillStatusAction[] = [];
  const actionsEl = child(bill, "actions");
  if (actionsEl !== undefined) {
    for (const item of children(actionsEl, "item")) {
      const date = childText(item, "actionDate");
      if (date === "") continue;
      actions.push({
        date: isoDateOnly(date),
        text: childText(item, "text"),
        type: childText(item, "type"),
        actionCode: childText(item, "actionCode"),
        recordedVotes: parseRecordedVotes(item),
      });
    }
  }

  const textVersions: BillStatusTextVersion[] = [];
  const versionsEl = child(bill, "textVersions");
  if (versionsEl !== undefined) {
    for (const item of children(versionsEl, "item")) {
      const type = childText(item, "type");
      const date = childText(item, "date");
      const url = descend(item, "formats", "item");
      if (type === "" || date === "") continue;
      const info = classifyTextVersion(type);
      textVersions.push({
        code: info.code,
        type,
        chamber: info.chamber,
        date: isoDateOnly(date),
        url: url === undefined ? "" : childText(url, "url"),
      });
    }
  }

  const relatedBills: BillStatusRelatedBill[] = [];
  const relatedEl = child(bill, "relatedBills");
  if (relatedEl !== undefined) {
    for (const item of children(relatedEl, "item")) {
      const type = childText(item, "type");
      const number = childText(item, "number");
      const congress = Number(childText(item, "congress"));
      if (type === "" || number === "") continue;
      relatedBills.push({
        title: truncate(childText(item, "title"), RELATED_TITLE_MAX),
        congress,
        label: billLabel(type, number),
        type,
        number,
        url: congressGovBillUrl(congress, type, number),
      });
    }
  }

  const latestActionEl = child(bill, "latestAction");
  const latestAction =
    latestActionEl === undefined
      ? { date: "", text: "" }
      : { date: isoDateOnly(childText(latestActionEl, "actionDate")), text: childText(latestActionEl, "text") };

  return {
    congress: Number(childText(bill, "congress")),
    billType,
    number: Number(childText(bill, "number")),
    title: childText(bill, "title"),
    shortTitle: parseShortTitle(bill),
    introducedDate: isoDateOnly(childText(bill, "introducedDate")),
    sponsor: parseSponsor(bill, billType),
    latestAction,
    actions,
    textVersions,
    relatedBills,
  };
}
