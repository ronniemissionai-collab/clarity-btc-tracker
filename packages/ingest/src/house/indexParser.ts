/**
 * Download + parse the Clerk's yearly financial-disclosure index.
 *
 * The zip contains `{YYYY}FD.xml`: flat machine-generated XML with one
 * `<Member>` element per filing (Prefix, Last, First, Suffix, FilingType,
 * StateDst, Year, FilingDate, DocID). Re-downloading daily and diffing DocIDs
 * is the change feed.
 */
import { unzipSync } from "fflate";
import { HouseIngestError, errorMessage } from "./errors.js";
import type { HouseFiling } from "./types.js";
import { houseIndexUrl } from "./urls.js";

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

/** Extract the text of `<tag>…</tag>` inside a block; "" for `<tag />` / absent. */
function field(block: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return m?.[1] === undefined ? "" : decodeXml(m[1].trim());
}

/** Clerk dates are M/D/YYYY; convert to ISO YYYY-MM-DD. */
export function clerkDateToIso(date: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date.trim());
  if (!m) {
    throw new HouseIngestError("index-parse", `unparseable Clerk date: "${date}"`);
  }
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
}

/** Parse `{YYYY}FD.xml` into filing rows. */
export function parseHouseIndexXml(xml: string): HouseFiling[] {
  const blocks = xml.match(/<Member>[\s\S]*?<\/Member>/g);
  if (!blocks) {
    throw new HouseIngestError("index-parse", "no <Member> rows found in FD index XML");
  }
  return blocks.map((block) => {
    const docId = field(block, "DocID");
    if (!docId) {
      throw new HouseIngestError(
        "index-parse",
        `FD index row missing DocID: ${block.slice(0, 200)}`,
      );
    }
    // Live indexes contain rows (e.g. withdrawal type "W") with empty
    // FilingDate/StateDst; tolerate them - only P-type rows are consumed.
    const filingDate = field(block, "FilingDate");
    const yearText = field(block, "Year");
    return {
      prefix: field(block, "Prefix"),
      last: field(block, "Last"),
      first: field(block, "First"),
      suffix: field(block, "Suffix"),
      filingType: field(block, "FilingType"),
      stateDst: field(block, "StateDst"),
      year: yearText === "" ? 0 : Number(yearText),
      filedDate: filingDate === "" ? "" : clerkDateToIso(filingDate),
      docId,
    };
  });
}

/** Unzip the index archive and parse `{YYYY}FD.xml`. */
export function parseHouseIndexZip(zip: Uint8Array, year: number): HouseFiling[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch (err) {
    throw new HouseIngestError("index-missing-entry", `not a readable zip: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  const wanted = `${year}FD.xml`;
  const name = Object.keys(entries).find((n) => n.endsWith(wanted));
  const entry = name === undefined ? undefined : entries[name];
  if (!entry) {
    throw new HouseIngestError(
      "index-missing-entry",
      `zip is missing ${wanted} (entries: ${Object.keys(entries).join(", ")})`,
    );
  }
  return parseHouseIndexXml(new TextDecoder("utf-8").decode(entry));
}

/** Download and parse the year's index. Throws typed errors on failure. */
export async function downloadHouseIndex(
  year: number,
  fetchImpl: typeof fetch = fetch,
): Promise<HouseFiling[]> {
  const url = houseIndexUrl(year);
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new HouseIngestError("index-download", `GET ${url} failed: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  if (!res.ok) {
    throw new HouseIngestError("index-download", `GET ${url} -> HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return parseHouseIndexZip(bytes, year);
}
