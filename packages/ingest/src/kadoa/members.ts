/**
 * Filer-name -> Member resolution.
 *
 * Kadoa publishes legal-ish full names ("David H McCormick", "Rohit Khanna",
 * "Nicholas Begich III", "Felix Barry Moore") while our roster uses the common
 * form ("Dave McCormick", "Ro Khanna", "Nick Begich III", "Barry Moore").
 * Matching is (given name x surname) keyed, after canonicalizing common
 * nicknames, dropping middle initials and generational suffixes. A chamber
 * check guards surname collisions across chambers.
 */
import type { Chamber, Member } from "@clarity-btc/shared";

/** nickname -> formal given name (both sides are canonicalized before lookup). */
const NICKNAMES: Record<string, string> = {
  dave: "david",
  gil: "gilbert",
  nick: "nicholas",
  ro: "rohit",
  tim: "timothy",
  josh: "joshua",
  mike: "michael",
  jim: "james",
  jimmy: "james",
  bob: "robert",
  rob: "robert",
  bobby: "robert",
  rick: "richard",
  dick: "richard",
  rich: "richard",
  tom: "thomas",
  tommy: "thomas",
  bill: "william",
  billy: "william",
  will: "william",
  greg: "gregory",
  dan: "daniel",
  danny: "daniel",
  ben: "benjamin",
  sam: "samuel",
  steve: "steven",
  ken: "kenneth",
  ed: "edward",
  eddie: "edward",
  ted: "edward",
  tony: "anthony",
  chris: "christopher",
  matt: "matthew",
  pat: "patrick",
  andy: "andrew",
  drew: "andrew",
  joe: "joseph",
  charlie: "charles",
  chuck: "charles",
  cindy: "cynthia",
  debbie: "deborah",
  liz: "elizabeth",
  beth: "elizabeth",
  kathy: "katherine",
  kate: "katherine",
  jerry: "gerald",
  larry: "lawrence",
  ron: "ronald",
  ronny: "ronald",
  don: "donald",
  frank: "francis",
  fred: "frederick",
  hank: "henry",
  jack: "john",
  johnny: "john",
  jon: "jonathan",
  max: "maxwell",
  nate: "nathan",
  pete: "peter",
  phil: "philip",
  ray: "raymond",
  rusty: "russell",
  vince: "vincent",
  wally: "walter",
  zach: "zachary",
};

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

function canonicalGiven(token: string): string {
  return NICKNAMES[token] ?? token;
}

/** Lowercase, strip diacritics/punctuation, drop generational suffixes. */
export function nameTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0 && !SUFFIXES.has(t));
}

/** (given, surname) candidate keys for a person name. */
function candidateKeys(name: string): string[] {
  const tokens = nameTokens(name);
  if (tokens.length < 2) return [];
  const last = tokens[tokens.length - 1] as string;
  const givens = tokens.slice(0, -1).filter((t) => t.length > 1); // drop initials
  const source = givens.length > 0 ? givens : tokens.slice(0, 1);
  return [...new Set(source.map((g) => `${canonicalGiven(g)} ${last}`))];
}

export interface MemberMatcher {
  /** Resolve a kadoa filer name (optionally chamber-checked) to a roster member. */
  match(filerName: string, chamber?: string | null): Member | undefined;
}

/**
 * Build a matcher over the member roster. Keys that map to two different
 * members are treated as ambiguous and refuse to match.
 */
export function buildMemberMatcher(members: Member[]): MemberMatcher {
  const byKey = new Map<string, Member>();
  const ambiguous = new Set<string>();
  for (const member of members) {
    for (const key of candidateKeys(member.name)) {
      const existing = byKey.get(key);
      if (existing !== undefined && existing.bioguideId !== member.bioguideId) {
        ambiguous.add(key);
        byKey.delete(key);
      } else if (!ambiguous.has(key)) {
        byKey.set(key, member);
      }
    }
  }
  return {
    match(filerName: string, chamber?: string | null): Member | undefined {
      let found: Member | undefined;
      for (const key of candidateKeys(filerName)) {
        const m = byKey.get(key);
        if (m === undefined) continue;
        if (found !== undefined && found.bioguideId !== m.bioguideId) return undefined; // ambiguous
        found = m;
      }
      if (found === undefined) return undefined;
      if (chamber != null && chamber !== "" && (chamber as Chamber) !== found.chamber) {
        return undefined;
      }
      return found;
    },
  };
}
