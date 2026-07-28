/**
 * Parse eFD DataTables search rows into typed filing references.
 *
 * Each row is [first, last, filer label, link HTML, MM/DD/YYYY], e.g.
 *   ["Bernie", "Moreno", "Moreno, Bernardo (Senator)",
 *    "<a href=\"/search/view/ptr/{uuid}/\" ...>Periodic Transaction Report for 07/24/2026</a>",
 *    "07/24/2026"]
 *
 * The link path encodes the channel: /view/ptr/ and /view/annual/ are
 * electronic (clean HTML tables), /view/paper/ is a scanned-GIF carousel.
 */
import { EFD_BASE_URL } from "./client.js";
import { SenateParseError } from "./errors.js";

export type SenateFilingChannel = "electronic" | "paper";
export type SenateFilingKind = "ptr" | "annual" | "other";

export interface SenateFilingRef {
  /** eFD filing uuid (from the /search/view/... link). */
  filingId: string;
  channel: SenateFilingChannel;
  kind: SenateFilingKind;
  filerFirst: string;
  filerLast: string;
  /** Third search column, e.g. "Moreno, Bernardo (Senator)" or "Senator". */
  filerLabel: string;
  /** Link text, e.g. "Periodic Transaction Report for 07/24/2026". */
  reportTitle: string;
  /** Absolute filing-page URL. */
  url: string;
  /** Submitted date, ISO YYYY-MM-DD. */
  filedDate: string;
}

/** "07/24/2026" -> "2026-07-24". */
export function usDateToIso(usDate: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(usDate.trim());
  if (!m) throw new SenateParseError(`unrecognized US date: "${usDate}"`);
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

const LINK_RE =
  /<a\s+href="(\/search\/view\/(ptr|annual|paper|regular)\/([0-9a-f-]{36})\/)"[^>]*>([\s\S]*?)<\/a>/i;

export function parseSearchRow(row: string[], baseUrl = EFD_BASE_URL): SenateFilingRef {
  const [first, last, filerLabel, linkHtml, dateStr] = row;
  if (
    first === undefined ||
    last === undefined ||
    filerLabel === undefined ||
    linkHtml === undefined ||
    dateStr === undefined
  ) {
    throw new SenateParseError(
      `search row has ${row.length} columns, expected 5: ${JSON.stringify(row)}`,
    );
  }
  const link = LINK_RE.exec(linkHtml);
  if (!link) {
    throw new SenateParseError(`no filing link in search row: ${JSON.stringify(linkHtml)}`);
  }
  const [, path, viewType, filingId, rawTitle] = link;
  const reportTitle = rawTitle!.replace(/\s+/g, " ").trim();

  const channel: SenateFilingChannel = viewType === "paper" ? "paper" : "electronic";
  let kind: SenateFilingKind;
  if (viewType === "ptr") kind = "ptr";
  else if (viewType === "annual") kind = "annual";
  else if (/periodic transaction/i.test(reportTitle)) kind = "ptr";
  else if (/(annual|new filer|candidate) report/i.test(reportTitle)) kind = "annual";
  else kind = "other";

  return {
    filingId: filingId!,
    channel,
    kind,
    filerFirst: first.trim(),
    // eFD last names occasionally carry stray trailing commas ("Moran,  ").
    filerLast: last.replace(/[\s,]+$/g, "").trim(),
    filerLabel: filerLabel.trim(),
    reportTitle,
    url: new URL(path!, baseUrl).toString(),
    filedDate: usDateToIso(dateStr),
  };
}

export function parseSearchRows(rows: string[][], baseUrl = EFD_BASE_URL): SenateFilingRef[] {
  return rows.map((row) => parseSearchRow(row, baseUrl));
}
