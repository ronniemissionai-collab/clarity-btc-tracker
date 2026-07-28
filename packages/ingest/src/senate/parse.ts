/**
 * Parsers for eFD filing pages (structures verified live 2026-07-28, saved as
 * test fixtures under packages/ingest/test/fixtures/senate/).
 *
 * - Electronic PTR  /search/view/ptr/{uuid}/    -> one <tr> per transaction:
 *   [#, Transaction Date, Owner, Ticker, Asset Name, Asset Type, Type, Amount, Comment]
 * - Electronic annual /search/view/annual/{uuid}/ -> "Part 3. Assets" table:
 *   [#, Asset, Asset Type, Owner, Value, Income Type, Income]
 * - Paper           /search/view/paper/{uuid}/  -> carousel of scanned GIFs on
 *   the public CDN (efd-media-public.senate.gov), no OCR here — callers emit
 *   OCR-flagged stubs carrying the image URLs.
 */
import { SenateParseError } from "./errors.js";
import { usDateToIso } from "./search.js";

// ---------------------------------------------------------------------------
// Small HTML utilities (eFD pages are simple server-rendered tables; a full
// DOM parser would be a heavier dependency than the problem warrants)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#35;": "#",
  "&nbsp;": " ",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39|#35);/g, (e) => ENTITIES[e] ?? e)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/** Strip tags, decode entities, collapse whitespace. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function rowsOf(sectionHtml: string): string[][] {
  const rows: string[][] = [];
  for (const tr of sectionHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]!);
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Amount / owner primitives
// ---------------------------------------------------------------------------

export interface AmountRange {
  lo: number;
  hi: number;
}

/**
 * Parse an eFD value band: "$1,001 - $15,000", "Over $50,000,000",
 * "None (or less than $1,001)".
 */
export function parseAmountRange(text: string): AmountRange {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const band = /\$([\d,]+)\s*-\s*\$([\d,]+)/.exec(cleaned);
  if (band) {
    return { lo: toNumber(band[1]!), hi: toNumber(band[2]!) };
  }
  const over = /over\s+\$([\d,]+)/i.exec(cleaned);
  if (over) {
    const n = toNumber(over[1]!);
    return { lo: n, hi: n };
  }
  const under = /less than \$([\d,]+)/i.exec(cleaned);
  if (under) {
    return { lo: 0, hi: toNumber(under[1]!) };
  }
  throw new SenateParseError(`unrecognized amount range: "${text}"`);
}

function toNumber(commaDigits: string): number {
  return Number(commaDigits.replace(/,/g, ""));
}

export type SenateOwner = "self" | "spouse" | "dependent" | "joint";

/** Map eFD owner labels to the shared Owner enum; null when unrecognized. */
export function parseOwner(label: string): SenateOwner | null {
  const l = label.trim().toLowerCase();
  if (l === "self") return "self";
  if (l === "spouse") return "spouse";
  if (l === "joint") return "joint";
  if (l.includes("child") || l.includes("dependent")) return "dependent";
  return null;
}

// ---------------------------------------------------------------------------
// Electronic PTR
// ---------------------------------------------------------------------------

export interface SenatePtrTransaction {
  /** 1-based row number as printed on the filing. */
  rowIndex: number;
  /** ISO transaction date. */
  transactionDate: string;
  /** Raw owner label ("Self", "Joint", "Spouse", "Dependent Child"). */
  ownerRaw: string;
  owner: SenateOwner | null;
  /** Exchange ticker, or null for "--" rows (private assets, direct crypto…). */
  ticker: string | null;
  /** First line of the Asset Name cell, verbatim. */
  assetName: string;
  /** Muted company/description sub-lines of the Asset Name cell, if any. */
  assetDetail?: string;
  assetType: string;
  /** "Purchase", "Sale (Full)", "Sale (Partial)", "Exchange". */
  transactionType: string;
  amount: AmountRange;
  comment?: string;
}

export interface SenatePtrFiling {
  /** ISO date from the "Filed MM/DD/YYYY" stamp on the page. */
  filedDate: string | null;
  transactions: SenatePtrTransaction[];
}

/** Parse an electronic PTR page (/search/view/ptr/{uuid}/). */
export function parsePtrHtml(html: string): SenatePtrFiling {
  const filedMatch = /Filed\s+(\d{2}\/\d{2}\/\d{4})/.exec(html);
  const filedDate = filedMatch ? usDateToIso(filedMatch[1]!) : null;

  const table = findTableWithHeader(html, "Transaction Date");
  if (table === null) {
    throw new SenateParseError("PTR page has no transactions table");
  }

  const transactions: SenatePtrTransaction[] = [];
  for (const cells of rowsOf(table)) {
    if (cells.length < 8) {
      throw new SenateParseError(
        `PTR transaction row has ${cells.length} cells, expected >= 8`,
      );
    }
    const [num, date, owner, tickerCell, assetCell, assetType, type, amount] = cells;
    const commentCell = cells[8];

    const tickerText = textOf(tickerCell!);
    const { assetName, assetDetail } = splitAssetCell(assetCell!);
    const comment = commentCell === undefined ? "" : textOf(commentCell);
    const ownerRaw = textOf(owner!);

    transactions.push({
      rowIndex: Number(textOf(num!)),
      transactionDate: usDateToIso(textOf(date!)),
      ownerRaw,
      owner: parseOwner(ownerRaw),
      ticker: tickerText === "--" || tickerText === "" ? null : tickerText,
      assetName,
      ...(assetDetail !== "" ? { assetDetail } : {}),
      assetType: textOf(assetType!),
      transactionType: textOf(type!),
      amount: parseAmountRange(textOf(amount!)),
      ...(comment !== "" && comment !== "--" ? { comment } : {}),
    });
  }
  // Filings render newest row first; return in printed row order (1, 2, …).
  transactions.sort((a, b) => a.rowIndex - b.rowIndex);
  return { filedDate, transactions };
}

/**
 * The Asset Name cell is the verbatim asset text plus optional muted
 * <div> sub-lines (Company / Description). Keep them separate.
 */
function splitAssetCell(cellHtml: string): { assetName: string; assetDetail: string } {
  const divStart = cellHtml.search(/<div\b/i);
  if (divStart === -1) {
    return { assetName: textOf(cellHtml), assetDetail: "" };
  }
  return {
    assetName: textOf(cellHtml.slice(0, divStart)),
    assetDetail: textOf(cellHtml.slice(divStart)),
  };
}

function findTableWithHeader(html: string, headerText: string): string | null {
  for (const m of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    if (m[1]!.includes(headerText)) return m[1]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Electronic annual report — Part 3. Assets
// ---------------------------------------------------------------------------

export interface SenateAnnualAsset {
  rowIndex: number;
  ticker: string | null;
  /** Asset name with the ticker prefix and "Description: …" tail removed. */
  assetName: string;
  assetType: string;
  ownerRaw: string;
  owner: SenateOwner | null;
  /** Reported value band; null when the filing shows "--" (no band given). */
  value: AmountRange | null;
}

/** Parse the "Part 3. Assets" table of an electronic annual report. */
export function parseAnnualAssets(html: string): SenateAnnualAsset[] {
  const start = html.search(/Part 3\.\s*Assets/i);
  if (start === -1) {
    throw new SenateParseError("annual report page has no 'Part 3. Assets' section");
  }
  const afterStart = html.slice(start);
  const end = afterStart.search(/Part 4[ab]?\./i);
  const section = end === -1 ? afterStart : afterStart.slice(0, end);

  const assets: SenateAnnualAsset[] = [];
  for (const cells of rowsOf(section)) {
    if (cells.length < 5) continue; // spacer / header-continuation rows
    const [num, assetCell, assetType, owner, value] = cells;

    const tickerMatch = /<a[^>]*>([\s\S]*?)<\/a>/i.exec(assetCell!);
    const ticker = tickerMatch ? textOf(tickerMatch[1]!) : null;
    let name = textOf(assetCell!.replace(/<a[^>]*>[\s\S]*?<\/a>/gi, " "));
    name = name.replace(/^-\s*/, "");
    const descIdx = name.indexOf("Description:");
    if (descIdx !== -1) name = name.slice(0, descIdx).trim();

    const ownerRaw = textOf(owner!);
    const valueText = textOf(value!);
    assets.push({
      rowIndex: Number(textOf(num!)),
      ticker: ticker === "--" || ticker === "" ? null : ticker,
      assetName: name,
      assetType: textOf(assetType!),
      ownerRaw,
      owner: parseOwner(ownerRaw),
      value:
        valueText === "--" || valueText === "" ? null : parseAmountRange(valueText),
    });
  }
  return assets;
}

// ---------------------------------------------------------------------------
// Paper filings — scanned GIF carousel
// ---------------------------------------------------------------------------

export interface SenatePaperFiling {
  /** Scan image URLs on the public CDN, in page order. */
  imageUrls: string[];
}

/** Parse a paper filing page (/search/view/paper/{uuid}/). */
export function parsePaperHtml(html: string): SenatePaperFiling {
  const urls: string[] = [];
  for (const m of html.matchAll(
    /https:\/\/efd-media-public\.senate\.gov\/[^\s"']+\.gif/g,
  )) {
    if (!urls.includes(m[0])) urls.push(m[0]);
  }
  if (urls.length === 0) {
    throw new SenateParseError("paper filing page has no scan images");
  }
  return { imageUrls: urls };
}
