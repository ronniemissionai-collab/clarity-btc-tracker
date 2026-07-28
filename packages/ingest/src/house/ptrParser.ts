/**
 * Parse layout text of an e-filed House PTR into transaction rows.
 *
 * Anchor-line strategy (marker-anchored regex, per the free-ingestion research
 * reference): every transaction renders one line holding the transaction-type
 * letter followed by transaction + notification dates and the amount band:
 *
 *   SP   APOLLO DEBT SOLUTIONS BDC   P   02/04/2026 03/06/2026   $1,001 - $15,000
 *        CLASS S [OT]
 *
 * Wrapped asset-name lines follow the anchor; a wrapped amount upper bound
 * ("$100,001 -" / "$250,000") lands on the next line too. Detail lines
 * (Filing Status / subholding / description) always carry a " : " marker
 * because the form's small-caps labels collapse to single letters.
 */

export interface ParsedPtrTransaction {
  /** Clerk owner code; null = filer themself. */
  ownerCode: "SP" | "JT" | "DC" | null;
  /** Verbatim asset text (wrap-joined, whitespace-collapsed), incl. [XX] code. */
  assetRaw: string;
  /** P = purchase, S = sale (partial or full), E = exchange. */
  typeCode: "P" | "S" | "E";
  partial: boolean;
  /** ISO transaction date. */
  transactionDate: string;
  /** ISO notification date. */
  notificationDate: string;
  amountLo: number;
  amountHi: number | null;
}

const ANCHOR_RE =
  /^\s*(?:(SP|JT|DC)\s{2,})?(.*?)\s+(P|S|E)\s*(\(partial\))?\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+\$([\d,]+)(?:\s*-\s*(?:\$([\d,]+))?)?\s*$/;

/** Lone wrapped amount bound, e.g. "$250,000". */
const AMOUNT_CONT_RE = /^\s*-?\s*\$([\d,]+)\s*$/;

/**
 * Wrapped asset text and wrapped amount bound sharing one layout line, e.g.
 * "BASKET [CS]                     $250,000".
 */
const TEXT_PLUS_AMOUNT_RE = /^(\s*.*\S)\s{2,}-?\s*\$([\d,]+)\s*$/;

/** Lines that terminate an asset-name wrap. */
const STOP_RES: RegExp[] = [
  /\s:\s/, // collapsed detail labels: "F  S  : New", "D  : ...", "S  O : ..."
  /:$/,
  /^\s*\*\s*For the complete list/i,
  /^\s*ID\s+Owner/i,
  /^\s*Type\b/,
  /^\s*Date\b/,
  /^\s*\$200\?/,
  /^\s*Gains\b/,
  /^\s*Digitally Signed/i,
  /^\s*$/,
];

function mdyToIso(mdy: string): string {
  const [mm = "", dd = "", yyyy = ""] = mdy.split("/");
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function money(text: string): number {
  return Number(text.replace(/,/g, ""));
}

/** Replace non-ASCII glyphs (checkboxes, en dashes, bullets) with spaces. */
function asciiClean(line: string): string {
  return line.replace(/[^\x20-\x7e]/g, " ");
}

export function parsePtrText(text: string): ParsedPtrTransaction[] {
  const lines = text.split(/\r?\n/).map(asciiClean);
  const rows: ParsedPtrTransaction[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = ANCHOR_RE.exec(lines[i] ?? "");
    if (!match) continue;
    const [, owner, assetHead, type, partial, txDate, notifDate, lo, hiOnLine] = match;
    if (!assetHead || assetHead.trim() === "") continue;

    let amountHi: number | null = hiOnLine === undefined ? null : money(hiOnLine);
    const assetParts: string[] = [assetHead];

    for (let j = i + 1; j < lines.length; j++) {
      let next = lines[j] ?? "";
      if (ANCHOR_RE.test(next)) break;
      if (amountHi === null) {
        const lone = AMOUNT_CONT_RE.exec(next);
        if (lone?.[1] !== undefined) {
          amountHi = money(lone[1]);
          continue;
        }
        const shared = TEXT_PLUS_AMOUNT_RE.exec(next);
        if (shared?.[1] !== undefined && shared[2] !== undefined) {
          amountHi = money(shared[2]);
          next = shared[1];
        }
      }
      if (STOP_RES.some((re) => re.test(next))) break;
      assetParts.push(next);
    }

    rows.push({
      ownerCode: owner === "SP" || owner === "JT" || owner === "DC" ? owner : null,
      assetRaw: assetParts.join(" ").replace(/\s+/g, " ").trim(),
      typeCode: type as "P" | "S" | "E",
      partial: partial !== undefined,
      transactionDate: mdyToIso(txDate ?? ""),
      notificationDate: mdyToIso(notifDate ?? ""),
      amountLo: money(lo ?? "0"),
      amountHi,
    });
  }
  return rows;
}
