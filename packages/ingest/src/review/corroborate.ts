/**
 * Corroborate new/changed BTC-universe holdings against recent news coverage.
 *
 * Official filings stay the primary source; Exa evidence only moves the
 * `verification` field, and only in the direction of MORE information:
 *
 *   unverified   -> corroborated   (supporting coverage found)
 *   unverified   -> conflict       (explicit contradicting coverage found)
 *   corroborated -> conflict       (contradiction outranks earlier support)
 *
 * Never downgraded: a "corroborated" row stays corroborated on a no-hit day,
 * and a "conflict" row stays flagged until the pipeline/humans resolve it -
 * absence of news is NOT evidence either way (epistemics ticket 08).
 *
 * Queries: 1-2 templates per holding (member name + security name/ticker +
 * "disclosure" / "bought sold"); the second template runs only when the first
 * was inconclusive and budget remains. Classification is conservative keyword
 * matching over titles + snippets; a conflict additionally requires the
 * contradiction (sale wording for a row we show as held) in the result TITLE
 * with the member and security both named there.
 */
import type {
  Holding,
  Member,
  Security,
  UniverseConfig,
} from "@clarity-btc/shared";
import { securityKey } from "@clarity-btc/shared";
import type { ExaClient, ExaSearchResult } from "./client.js";
import { startPublishedDate, todayIso } from "./dates.js";
import { errorMessage } from "./errors.js";

type SourceRef = Holding["sources"][number];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CorroborateOptions {
  /** Roster used to turn memberId into a searchable name. */
  members: Member[];
  /** config/universe.json (or its securities array) for security names. */
  universe: UniverseConfig | Security[];
  client: ExaClient;
  /** "Today" (ISO date) for the recency window; default: current UTC date. */
  now?: string;
  /** How far back coverage may date; default 90 days (45-day filing lag + tail). */
  lookbackDays?: number;
  /** 1 or 2 query templates per holding; default 2. */
  maxQueriesPerHolding?: number;
  /** Results requested per query; default 5. */
  numResults?: number;
  log?: (line: string) => void;
}

export interface CorroborateResult {
  /** Same order as the input; untouched rows are passed through unchanged. */
  reviewed: Holding[];
  queriesUsed: number;
  /** Queries not issued because the daily budget ran out (each one logged). */
  queriesSkipped: number;
  /** Holdings that got ZERO queries (budget exhausted) - they stay unverified. */
  skippedHoldings: number;
  /** Non-fatal per-query problems (network/HTTP); the row stays unchanged. */
  issues: string[];
}

// ---------------------------------------------------------------------------
// Query templates
// ---------------------------------------------------------------------------

/** 1-2 query templates: member + security + "disclosure" / "bought sold". */
export function buildHoldingQueries(
  memberName: string,
  security: Pick<Security, "ticker" | "name" | "kind">,
): [string, string] {
  const isDirect = security.kind === "direct";
  const label = isDirect ? "Bitcoin" : `${security.name} ${security.ticker}`;
  const word = isDirect ? "Bitcoin" : security.ticker;
  return [
    `${memberName} ${label} disclosure`,
    `${memberName} ${word} bought sold`,
  ];
}

// ---------------------------------------------------------------------------
// Conservative keyword classification
// ---------------------------------------------------------------------------

const SALE_RE =
  /\b(sold|sells?|sale|sell-?off|dump(?:ed|s)?|exit(?:ed|s)?|offload(?:ed|s)?|divest(?:ed|s)?|liquidat(?:ed|es)?)\b/;
const BUY_RE =
  /\b(bought|buys?|purchas(?:e|es|ed)|acquir(?:e|es|ed)|adds?|added|invest(?:s|ed)?|scoop(?:ed|s)?)\b/;
const DISCLOSURE_RE =
  /\b(disclos(?:e|es|ed|ure|ures)|fil(?:e|es|ed|ing|ings)|report(?:s|ed)?|periodic transaction|stock act|holds?|holding)\b/;

const NAME_SUFFIX_RE = /^(jr\.?|sr\.?|ii|iii|iv)$/i;

/** "Nick Begich III" -> "begich"; "Dave McCormick" -> "mccormick". */
export function memberLastName(name: string): string {
  const tokens = name
    .trim()
    .split(/\s+/)
    .filter((t) => !NAME_SUFFIX_RE.test(t));
  return (tokens.at(-1) ?? name).toLowerCase();
}

const GENERIC_NAME_WORDS = new Set([
  "the",
  "trust",
  "fund",
  "shares",
  "share",
  "inc",
  "corp",
  "class",
  "common",
  "stock",
  "wise",
  "origin",
  "mini",
  "direct",
  "holding",
  "holdings",
  "platforms",
  "global",
]);

/** Lowercased tokens that mark a result as being about this security. */
export function securityTokens(ticker: string, name: string): string[] {
  const tokens = new Set<string>([ticker.toLowerCase()]);
  for (const word of name.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 4 && !GENERIC_NAME_WORDS.has(word)) tokens.add(word);
  }
  return [...tokens];
}

export type ResultClass = "supporting" | "conflict" | "none";

/**
 * Classify one search result against one holding. Conservative on purpose:
 * relevance needs the member's last name AND a security token in title+text;
 * a conflict (reported sale of a row we show as held) additionally needs the
 * sale wording - and no buy wording - in the TITLE with both named there.
 */
export function classifyResult(
  result: ExaSearchResult,
  lastName: string,
  tokens: string[],
  status: Holding["status"],
): ResultClass {
  const title = (result.title ?? "").toLowerCase();
  const text = `${title} ${result.text ?? ""}`.toLowerCase();
  if (!text.includes(lastName)) return "none";
  if (!tokens.some((t) => text.includes(t))) return "none";

  if (status !== "sold") {
    const titleRelevant =
      title.includes(lastName) && tokens.some((t) => title.includes(t));
    if (titleRelevant && SALE_RE.test(title) && !BUY_RE.test(title)) {
      return "conflict";
    }
    if (BUY_RE.test(text) || DISCLOSURE_RE.test(text)) return "supporting";
    return "none";
  }

  // Row already marked sold: sale/disclosure coverage supports it. Buy
  // coverage is NOT treated as a contradiction (they did buy before selling,
  // and snippets carry no reliable dates) - conservative by design.
  if (SALE_RE.test(text) || DISCLOSURE_RE.test(text)) return "supporting";
  return "none";
}

// ---------------------------------------------------------------------------
// Outcome application
// ---------------------------------------------------------------------------

/** Cap on news source URLs appended per corroborated holding. */
const MAX_SUPPORTING_SOURCES = 2;

function appendNewsSources(sources: SourceRef[], evidence: ExaSearchResult[]): SourceRef[] {
  const out = [...sources];
  for (const result of evidence) {
    if (!/^https?:\/\//.test(result.url)) continue; // SourceRef.url must be a URL
    if (out.some((s) => s.url === result.url)) continue;
    const title = result.title?.trim();
    out.push({
      kind: "news",
      url: result.url,
      ...(title !== undefined && title !== "" ? { title } : {}),
    });
  }
  return out;
}

function applyOutcome(
  holding: Holding,
  outcome: "corroborated" | "conflict" | null,
  evidence: ExaSearchResult[],
): Holding {
  if (outcome === null) return holding; // no-hit day: never downgrade
  if (outcome === "corroborated" && holding.verification === "conflict") {
    // A flagged conflict stays flagged until resolved upstream.
    return holding;
  }
  return {
    ...holding,
    verification: outcome,
    sources: appendNewsSources(holding.sources, evidence),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function corroborateHoldings(
  holdings: Holding[],
  options: CorroborateOptions,
): Promise<CorroborateResult> {
  const { client } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? todayIso();
  const publishedAfter = startPublishedDate(now, options.lookbackDays ?? 90);
  const maxPerHolding = Math.min(2, Math.max(1, options.maxQueriesPerHolding ?? 2));
  const numResults = options.numResults ?? 5;

  const membersById = new Map(options.members.map((m) => [m.bioguideId, m]));
  const securities = Array.isArray(options.universe)
    ? options.universe
    : options.universe.universe;
  const securitiesByKey = new Map(securities.map((s) => [securityKey(s), s]));

  const usedBefore = client.queriesUsed;
  const reviewed: Holding[] = [];
  const issues: string[] = [];
  let queriesSkipped = 0;
  let skippedHoldings = 0;

  for (const holding of holdings) {
    const rowLabel = `${holding.memberId} ${securityKey(holding.security)} (${holding.owner})`;

    const member = membersById.get(holding.memberId);
    if (member === undefined) {
      issues.push(`${rowLabel}: memberId not in the roster - cannot build a query`);
      reviewed.push(holding);
      continue;
    }
    const security =
      securitiesByKey.get(securityKey(holding.security)) ??
      ({
        ticker: holding.security.ticker,
        name: holding.security.ticker,
        kind: holding.security.kind,
      } satisfies Pick<Security, "ticker" | "name" | "kind">);

    const lastName = memberLastName(member.name);
    const tokens = securityTokens(security.ticker, security.name);
    const queries = buildHoldingQueries(member.name, security).slice(0, maxPerHolding);

    let outcome: "corroborated" | "conflict" | null = null;
    let evidence: ExaSearchResult[] = [];
    let queried = false;

    for (const query of queries) {
      if (client.queriesRemaining <= 0) {
        queriesSkipped += 1;
        log(`exa budget exhausted: skipped query "${query}" for ${rowLabel}`);
        break; // later templates for this row would be skipped too
      }
      let results: ExaSearchResult[];
      try {
        const response = await client.search({
          query,
          type: "auto",
          numResults,
          startPublishedDate: publishedAfter,
          contents: { text: { maxCharacters: 1000 } },
        });
        results = response.results;
      } catch (err) {
        issues.push(`${rowLabel}: query "${query}" failed: ${errorMessage(err)}`);
        continue;
      }
      queried = true;

      const conflicts: ExaSearchResult[] = [];
      const supporting: ExaSearchResult[] = [];
      for (const result of results) {
        const cls = classifyResult(result, lastName, tokens, holding.status);
        if (cls === "conflict") conflicts.push(result);
        else if (cls === "supporting") supporting.push(result);
      }
      if (conflicts.length > 0) {
        outcome = "conflict";
        evidence = conflicts.slice(0, MAX_SUPPORTING_SOURCES);
        break;
      }
      if (supporting.length > 0) {
        outcome = "corroborated";
        evidence = supporting.slice(0, MAX_SUPPORTING_SOURCES);
        break;
      }
    }

    if (!queried && outcome === null && client.queriesRemaining <= 0) {
      skippedHoldings += 1;
    }
    reviewed.push(applyOutcome(holding, outcome, evidence));
  }

  return {
    reviewed,
    queriesUsed: client.queriesUsed - usedBefore,
    queriesSkipped,
    skippedHoldings,
    issues,
  };
}
