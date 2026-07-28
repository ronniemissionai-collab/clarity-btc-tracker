/**
 * Resolution helpers: filing text -> universe securities, filer names ->
 * members of Congress.
 *
 * Security resolution honours the composite ticker+kind key from the shared
 * contract: exchange ticker "BTC" resolves to the Grayscale Mini Trust ETF
 * (a listed security), while a non-ticker "Bitcoin" asset line resolves via
 * aliases to the BTC:direct pseudo-ticker.
 */
import type { Member, Security, SecurityRef } from "@clarity-btc/shared";

function normalizeName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SecurityResolver {
  /**
   * Resolve a filing line to a universe security, or null when it maps to
   * nothing in the universe.
   */
  resolve(ticker: string | null, assetName: string): SecurityRef | null;
}

export function buildSecurityResolver(universe: Security[]): SecurityResolver {
  const byTicker = new Map<string, Security[]>();
  const byName = new Map<string, Security>();

  for (const security of universe) {
    const t = security.ticker.toUpperCase();
    const list = byTicker.get(t);
    if (list) list.push(security);
    else byTicker.set(t, [security]);

    byName.set(normalizeName(security.name), security);
    for (const alias of security.aliases ?? []) {
      byName.set(normalizeName(alias), security);
    }
  }

  const toRef = (s: Security): SecurityRef => ({ ticker: s.ticker, kind: s.kind });

  return {
    resolve(ticker, assetName): SecurityRef | null {
      const byAssetName = byName.get(normalizeName(assetName));

      if (ticker !== null && ticker !== "" && ticker !== "--") {
        const candidates = byTicker.get(ticker.toUpperCase());
        if (!candidates || candidates.length === 0) return null;
        if (candidates.length === 1) return toRef(candidates[0]!);
        // Ticker collision (e.g. "BTC" = direct pseudo-ticker vs Grayscale
        // Mini Trust). A filing row carrying an exchange ticker is a listed
        // security; prefer the asset-name match, then any non-"direct" kind.
        if (byAssetName && candidates.includes(byAssetName)) return toRef(byAssetName);
        const listed = candidates.find((c) => c.kind !== "direct");
        return toRef(listed ?? candidates[0]!);
      }

      // No ticker ("--"): match the verbatim asset text against security
      // names and aliases — this is how direct "Bitcoin" lines resolve.
      if (byAssetName) return toRef(byAssetName);

      // eFD annual-report asset cells append sub-field clauses to the asset
      // name ("Bitcoin Exchange/Platform : River Financial Inc", "... Company:
      // ... Description: ..."). Strip everything from the first such marker
      // and retry the exact match: "Bitcoin Exchange/Platform : River" ->
      // "Bitcoin" resolves, while "Bitcoin Miners Description : Bitmain S21"
      // -> "Bitcoin Miners" still resolves to nothing (correctly - mining rigs
      // are not a BTC position).
      const normalized = normalizeName(assetName);
      for (const marker of [" exchange platform", " description", " company"]) {
        const at = normalized.indexOf(marker);
        if (at <= 0) continue;
        const stripped = byName.get(normalized.slice(0, at).trim());
        if (stripped) return toRef(stripped);
      }
      return null;
    },
  };
}

export type MemberResolver = (first: string, last: string) => Member | null;

/**
 * Resolve an eFD filer (first/last as rendered in search results, which may
 * be ALL CAPS, carry stray commas, or middle initials) to a Senate member.
 */
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/** Last surname token of a display name, skipping generational suffixes. */
function surnameOf(name: string): string {
  const tokens = normalizeName(name)
    .split(" ")
    .filter((t) => t.length > 0 && !NAME_SUFFIXES.has(t));
  return tokens[tokens.length - 1] ?? "";
}

export function buildMemberResolver(members: Member[]): MemberResolver {
  const senators = members.filter((m) => m.chamber === "senate");
  const byLast = new Map<string, Member[]>();
  for (const member of senators) {
    const last = surnameOf(member.name);
    const list = byLast.get(last);
    if (list) list.push(member);
    else byLast.set(last, [member]);
  }

  return (first, last) => {
    const candidates = byLast.get(normalizeName(last));
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;
    // Shared last name: require a first-name (or first-initial) match.
    const firstNorm = normalizeName(first).split(" ")[0] ?? "";
    const exact = candidates.find(
      (m) => normalizeName(m.name).split(" ")[0] === firstNorm,
    );
    if (exact) return exact;
    const byInitial = candidates.filter(
      (m) => normalizeName(m.name)[0] === firstNorm[0],
    );
    return byInitial.length === 1 ? byInitial[0]! : null;
  };
}
