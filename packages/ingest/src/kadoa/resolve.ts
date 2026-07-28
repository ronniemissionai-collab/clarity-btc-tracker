/**
 * Security resolution: kadoa (ticker, asset_name, asset_type) -> universe entry.
 *
 * Rules, in order:
 * 1. Ticker lookup against `config/universe.json` tickers.
 * 2. If the ticker is missing/unknown, alias matching over asset_name: the full
 *    string, " - "-separated segments (kadoa emits "iShares Bitcoin Trust ETF -
 *    iShares Bitcoin Trust ETF", "Strategy Inc - Class A Common Stock"),
 *    parenthetical contents ("BTC (Bitcoin)"), each tried against security
 *    names, aliases, and tickers, with generic share-class suffixes stripped.
 * 3. The "BTC" ticker collision (direct-holding pseudo-ticker vs Grayscale
 *    Bitcoin Mini Trust ETF's literal exchange ticker) is disambiguated by
 *    name/alias score, then by the crypto asset_type hint ("CT" -> direct).
 *
 * Verified real shapes this handles (live fixture, 2026-07-28):
 *   {ticker:"IBIT", asset_name:"iShares Bitcoin Trust ETF - iShares Bitcoin Trust ETF"}
 *   {ticker:null,  asset_name:"BTC", asset_type:"CT"}
 *   {ticker:"BTC", asset_name:"Bitcoin", asset_type:"CT"}
 *   {ticker:null,  asset_name:"BTC (Bitcoin)", asset_type:"CT"}
 *   {ticker:"MSTR", asset_name:"Strategy Inc - Class A Common Stock"}
 */
import type { Security, SecurityRef } from "@clarity-btc/shared";

/** kadoa asset_type codes meaning "cryptocurrency held directly". */
const CRYPTO_ASSET_TYPES = new Set(["CT", "Cryptocurrency"]);

/** Generic share-class suffixes that carry no identity. */
const GENERIC_SEGMENTS = new Set(
  [
    "common stock",
    "class a common stock",
    "class b common stock",
    "class c common stock",
    "ordinary shares",
    "american depositary shares",
    "depositary shares",
    "preferred stock",
    "stock",
    "etf",
  ].map((s) => s),
);

/** Lowercase, strip punctuation to single spaces. */
export function normalizeAssetText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/ +/g, " ");
}

function stripGenericSuffix(normalized: string): string {
  for (const suffix of GENERIC_SEGMENTS) {
    if (normalized.endsWith(" " + suffix)) {
      return normalized.slice(0, -(suffix.length + 1)).trim();
    }
  }
  return normalized;
}

/** Candidate name segments of a kadoa asset_name, most-specific first. */
function assetNameSegments(assetName: string): string[] {
  const segments: string[] = [assetName];
  for (const part of assetName.split(/\s+-\s+/)) segments.push(part);
  for (const m of assetName.matchAll(/\(([^)]+)\)/g)) {
    if (m[1] !== undefined) segments.push(m[1]);
  }
  segments.push(assetName.replace(/\([^)]*\)/g, " "));
  const out: string[] = [];
  for (const seg of segments) {
    const norm = normalizeAssetText(seg);
    for (const candidate of [norm, stripGenericSuffix(norm)]) {
      if (candidate.length > 0 && !GENERIC_SEGMENTS.has(candidate) && !out.includes(candidate)) {
        out.push(candidate);
      }
    }
  }
  return out;
}

export interface ResolveInput {
  ticker?: string | null | undefined;
  assetName?: string | null | undefined;
  assetType?: string | null | undefined;
}

export interface SecurityResolver {
  resolve(input: ResolveInput): SecurityRef | null;
}

/** Names/aliases/ticker of one security, normalized. */
function securityAliases(sec: Security): string[] {
  const aliases = [sec.name, sec.ticker, ...(sec.aliases ?? [])];
  const out: string[] = [];
  for (const a of aliases) {
    const norm = normalizeAssetText(a);
    for (const candidate of [norm, stripGenericSuffix(norm)]) {
      if (candidate.length > 0 && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

/**
 * Build a resolver over the security universe (`config/universe.json`).
 * Returns null for assets outside the universe — callers keep those trades
 * with `security: null` per the shared Trade contract.
 */
export function buildSecurityResolver(universe: Security[]): SecurityResolver {
  const byTicker = new Map<string, Security[]>();
  for (const sec of universe) {
    const key = sec.ticker.toUpperCase();
    const list = byTicker.get(key);
    if (list === undefined) byTicker.set(key, [sec]);
    else list.push(sec);
  }
  // alias -> securities (kept as lists so collisions disambiguate like tickers)
  const byAlias = new Map<string, Security[]>();
  for (const sec of universe) {
    for (const alias of securityAliases(sec)) {
      const list = byAlias.get(alias);
      if (list === undefined) byAlias.set(alias, [sec]);
      else if (!list.includes(sec)) list.push(sec);
    }
  }

  function disambiguate(candidates: Security[], input: ResolveInput): Security | null {
    if (candidates.length === 1) return candidates[0] ?? null;
    // 1. Score by name/alias match on the asset name.
    if (input.assetName != null && input.assetName !== "") {
      const segments = assetNameSegments(input.assetName);
      let best: Security | null = null;
      let bestScore = 0;
      let tied = false;
      for (const sec of candidates) {
        const aliases = securityAliases(sec);
        // exact segment==alias match scores 2; substring containment scores 1
        let score = 0;
        for (const seg of segments) {
          for (const alias of aliases) {
            if (seg === alias) score = Math.max(score, 2);
            else if (alias.length > 3 && seg.includes(alias)) score = Math.max(score, 1);
          }
        }
        if (score > bestScore) {
          best = sec;
          bestScore = score;
          tied = false;
        } else if (score === bestScore && score > 0 && best !== null && best !== sec) {
          tied = true;
        }
      }
      if (best !== null && bestScore > 0 && !tied) return best;
    }
    // 2. Crypto asset_type -> the direct-holding entry.
    if (input.assetType != null && CRYPTO_ASSET_TYPES.has(input.assetType)) {
      const direct = candidates.filter((s) => s.kind === "direct");
      if (direct.length === 1) return direct[0] ?? null;
    }
    return null;
  }

  return {
    resolve(input: ResolveInput): SecurityRef | null {
      let candidates: Security[] = [];
      const ticker = input.ticker?.trim().toUpperCase();
      if (ticker !== undefined && ticker !== "") {
        // Live tickers first, then retired-ticker aliases (e.g. SMLR -> ASST).
        candidates = byTicker.get(ticker) ?? byAlias.get(normalizeAssetText(ticker)) ?? [];
      }
      if (candidates.length === 0 && input.assetName != null && input.assetName !== "") {
        for (const segment of assetNameSegments(input.assetName)) {
          const viaAlias = byAlias.get(segment);
          if (viaAlias !== undefined && viaAlias.length > 0) {
            candidates = viaAlias;
            break;
          }
          const viaTicker = byTicker.get(segment.toUpperCase());
          if (viaTicker !== undefined && viaTicker.length > 0) {
            candidates = viaTicker;
            break;
          }
        }
      }
      const chosen = disambiguate(candidates, input);
      return chosen === null ? null : { ticker: chosen.ticker, kind: chosen.kind };
    },
  };
}
