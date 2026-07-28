/** Date normalization for the three feeds' inconsistent formats. */

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

function pad2(n: string | number): string {
  return String(n).padStart(2, "0");
}

function monthNumber(name: string): string {
  const month = MONTHS[name.toLowerCase()];
  if (month === undefined) throw new Error(`unrecognized month name: ${name}`);
  return month;
}

/** "2025-07-17" or "2025-07-17T19:30:31Z" -> "2025-07-17". */
export function isoDateOnly(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (m === null || m[1] === undefined) throw new Error(`not an ISO date: ${value}`);
  return m[1];
}

/** House Clerk EVS action-date, "17-Jul-2025" -> "2025-07-17". */
export function parseClerkActionDate(value: string): string {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  if (m === null) throw new Error(`unrecognized Clerk action-date: ${value}`);
  return `${m[3]}-${monthNumber(m[2] as string)}-${pad2(m[1] as string)}`;
}

/** Senate vote-menu vote_date, "27-Jul" plus the menu's congress_year -> "2026-07-27". */
export function parseSenateMenuDate(value: string, congressYear: number): string {
  const m = /^(\d{1,2})-([A-Za-z]{3})$/.exec(value.trim());
  if (m === null) throw new Error(`unrecognized Senate menu vote_date: ${value}`);
  return `${congressYear}-${monthNumber(m[2] as string)}-${pad2(m[1] as string)}`;
}

/** Senate vote-detail vote_date, "January 5, 2026,  05:31 PM" -> "2026-01-05". */
export function parseSenateDetailDate(value: string): string {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(value.trim());
  if (m === null) throw new Error(`unrecognized Senate detail vote_date: ${value}`);
  return `${m[3]}-${monthNumber(m[1] as string)}-${pad2(m[2] as string)}`;
}
