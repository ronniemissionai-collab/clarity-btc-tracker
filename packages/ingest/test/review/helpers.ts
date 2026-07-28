/**
 * Fixture-backed helpers for the Exa review tests. The two JSON fixtures are
 * real api.exa.ai/search responses captured live on 2026-07-28 (one
 * corroboration-style query, one news-strip query). No test touches the
 * network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Holding, Member, Security } from "@clarity-btc/shared";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "review",
);

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8"));
}

export const corroborationFixture = (): unknown => loadFixture("search-corroboration.json");
export const newsFixture = (): unknown => loadFixture("search-news.json");

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Fake fetch that answers each Exa POST by matching the request's `query`
 * against `routes` (substring match, first hit wins); unmatched queries get
 * an empty result set. Records every call for assertions.
 */
export function exaFetchFake(
  routes: Array<{ match: string; body: unknown; status?: number }>,
  calls: RecordedCall[] = [],
): typeof fetch {
  return async (input, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: parsed,
    });
    const query = String(parsed.query ?? "");
    for (const route of routes) {
      if (query.includes(route.match)) {
        return jsonResponse(route.body, route.status ?? 200);
      }
    }
    return jsonResponse({ requestId: "empty", results: [] });
  };
}

/** Minimal Exa-shaped response around the given results. */
export function exaResponse(
  results: Array<{ title: string | null; url: string; publishedDate?: string; text?: string }>,
): unknown {
  return { requestId: "fake", resolvedSearchType: "neural", results };
}

// ---------------------------------------------------------------------------
// Shared domain fixtures
// ---------------------------------------------------------------------------

export const biggs: Member = {
  bioguideId: "B001325",
  name: "Sheri Biggs",
  party: "R",
  chamber: "house",
  state: "SC",
  district: "SC-03",
  active: true,
};

export const gill: Member = {
  bioguideId: "G000603",
  name: "Brandon Gill",
  party: "R",
  chamber: "house",
  state: "TX",
  district: "TX-26",
  active: true,
};

export const lummis: Member = {
  bioguideId: "L000571",
  name: "Cynthia Lummis",
  party: "R",
  chamber: "senate",
  state: "WY",
  active: true,
};

export const members: Member[] = [biggs, gill, lummis];

export const universe: Security[] = [
  {
    ticker: "BTC",
    name: "Bitcoin (direct holding)",
    tier: 1,
    kind: "direct",
    aliases: ["Bitcoin", "BTC-USD"],
  },
  { ticker: "IBIT", name: "iShares Bitcoin Trust ETF", tier: 1, kind: "spot-etf" },
  { ticker: "FBTC", name: "Fidelity Wise Origin Bitcoin Fund", tier: 1, kind: "spot-etf" },
];

export function holding(overrides: Partial<Holding> = {}): Holding {
  return {
    memberId: "B001325",
    security: { ticker: "IBIT", kind: "spot-etf" },
    owner: "self",
    range: { lo: 100_001, hi: 250_000 },
    status: "holds",
    asOf: "2026-04-15",
    extraction: "pdf-text",
    verification: "unverified",
    sources: [
      {
        kind: "filing",
        url: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20030000.pdf",
      },
    ],
    ...overrides,
  };
}
