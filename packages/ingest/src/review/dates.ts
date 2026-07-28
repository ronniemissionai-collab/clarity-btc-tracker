/** Small date helpers shared by the corroboration and news-strip queries. */

/** Current UTC date as ISO YYYY-MM-DD. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `days` before `nowIso`, as the ISO datetime form Exa's startPublishedDate
 * expects (midnight UTC).
 */
export function startPublishedDate(nowIso: string, days: number): string {
  const now = Date.parse(`${nowIso}T00:00:00Z`);
  if (Number.isNaN(now)) throw new Error(`invalid ISO date: "${nowIso}"`);
  const start = new Date(now - days * 86_400_000);
  return `${start.toISOString().slice(0, 10)}T00:00:00.000Z`;
}
