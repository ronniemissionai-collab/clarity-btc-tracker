/**
 * Resolution helpers: Clerk filer -> Member (bioguide id), and raw filing
 * asset text -> Security in the config/universe.json universe.
 */
import type { Member, Security, SecurityRef, UniverseConfig } from "@clarity-btc/shared";
import type { HouseFiling } from "./types.js";

/** "SC03" -> { state: "SC", district: "SC-03" }; "AK00" (at-large) -> "AK-AL". */
export function districtFromStateDst(stateDst: string): { state: string; district: string } | null {
  const m = /^([A-Z]{2})(\d{2})$/.exec(stateDst.trim());
  if (!m) return null;
  const [, state = "", dd = ""] = m;
  return { state, district: dd === "00" ? `${state}-AL` : `${state}-${dd}` };
}

export function filerDisplayName(filing: HouseFiling): string {
  return [filing.prefix, filing.first, filing.last, filing.suffix]
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * Match a Clerk filing to a House member in the roster: same state, and the
 * member's display name contains the filing's last name as a whole word.
 * Ambiguities (same surname + state) are narrowed by district, else dropped.
 */
export function resolveHouseMember(filing: HouseFiling, members: Member[]): Member | null {
  const loc = districtFromStateDst(filing.stateDst);
  if (!loc) return null;
  const lastRe = new RegExp(
    `(^|\\s)${filing.last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\s)`,
    "i",
  );
  const candidates = members.filter(
    (m) => m.chamber === "house" && m.state === loc.state && lastRe.test(m.name),
  );
  if (candidates.length === 1) return candidates[0] ?? null;
  if (candidates.length > 1) {
    const byDistrict = candidates.filter((m) => m.district === loc.district);
    if (byDistrict.length === 1) return byDistrict[0] ?? null;
  }
  return null;
}

export interface SecurityResolver {
  (assetRaw: string): SecurityRef | null;
}

function toRef(sec: Security): SecurityRef {
  return { ticker: sec.ticker, kind: sec.kind };
}

/**
 * Build a resolver from the security universe.
 *
 * Order of precedence:
 * 1. Parenthesized exchange ticker in the filing text, e.g. "(IBIT)". When a
 *    ticker is shared (the literal "BTC" is both the direct-holding
 *    pseudo-ticker and the Grayscale Mini Trust exchange ticker), prefer the
 *    listed security — a parenthesized ticker in a filing is an exchange
 *    ticker, not a direct holding.
 * 2. Security names and aliases, longest pattern first so "iShares Bitcoin
 *    Trust ETF" wins over the bare "Bitcoin" alias. Patterns of >= 6 chars
 *    match as substrings; shorter ones ("BTC", "XBT") must stand alone as a
 *    whole word.
 */
export function buildSecurityResolver(universe: UniverseConfig | Security[]): SecurityResolver {
  const securities = Array.isArray(universe) ? universe : universe.universe;

  const byTicker = new Map<string, Security[]>();
  for (const sec of securities) {
    const list = byTicker.get(sec.ticker.toUpperCase()) ?? [];
    list.push(sec);
    byTicker.set(sec.ticker.toUpperCase(), list);
  }

  const patterns: { pattern: string; sec: Security }[] = [];
  for (const sec of securities) {
    patterns.push({ pattern: sec.name, sec });
    for (const alias of sec.aliases ?? []) {
      patterns.push({ pattern: alias, sec });
    }
  }
  patterns.sort((a, b) => b.pattern.length - a.pattern.length);

  return (assetRaw: string): SecurityRef | null => {
    // Strip the Clerk asset-type code ("[ST]") before name matching.
    const cleaned = assetRaw
      .replace(/\[[A-Z]{2}\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const tickerMatch = /\(([A-Z][A-Z0-9.-]{0,9})\)/.exec(cleaned);
    if (tickerMatch?.[1] !== undefined) {
      const matches = byTicker.get(tickerMatch[1].toUpperCase());
      if (matches && matches.length > 0) {
        const listed = matches.find((s) => s.kind !== "direct");
        return toRef(listed ?? matches[0]!);
      }
    }

    const haystack = cleaned.toLowerCase();
    for (const { pattern, sec } of patterns) {
      const needle = pattern.toLowerCase();
      if (needle.length >= 6) {
        if (haystack.includes(needle)) return toRef(sec);
      } else {
        const wordRe = new RegExp(
          `(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`,
        );
        if (wordRe.test(haystack)) return toRef(sec);
      }
    }
    return null;
  };
}
