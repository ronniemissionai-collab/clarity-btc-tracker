import { describe, expect, it } from "vitest";
import { parseHoldings } from "@clarity-btc/shared";
import {
  buildHoldingQueries,
  corroborateHoldings,
  ExaClient,
  memberLastName,
} from "../../src/review/index.js";
import {
  corroborationFixture,
  exaFetchFake,
  exaResponse,
  holding,
  members,
  universe,
  type RecordedCall,
} from "./helpers.js";

function client(
  routes: Array<{ match: string; body: unknown; status?: number }>,
  budget = 30,
  calls: RecordedCall[] = [],
): ExaClient {
  return new ExaClient({
    apiKey: "test-key",
    queryBudget: budget,
    fetchImpl: exaFetchFake(routes, calls),
  });
}

describe("query templates", () => {
  it("builds member + security name/ticker + disclosure/bought/sold queries", () => {
    const [q1, q2] = buildHoldingQueries("Sheri Biggs", {
      ticker: "IBIT",
      name: "iShares Bitcoin Trust ETF",
      kind: "spot-etf",
    });
    expect(q1).toBe("Sheri Biggs iShares Bitcoin Trust ETF IBIT disclosure");
    expect(q2).toBe("Sheri Biggs IBIT bought sold");
  });

  it("uses plain 'Bitcoin' for the direct-BTC pseudo-ticker", () => {
    const [q1] = buildHoldingQueries("Brandon Gill", {
      ticker: "BTC",
      name: "Bitcoin (direct holding)",
      kind: "direct",
    });
    expect(q1).toBe("Brandon Gill Bitcoin disclosure");
  });

  it("strips generational suffixes for last-name matching", () => {
    expect(memberLastName("Nick Begich III")).toBe("begich");
    expect(memberLastName("Dave McCormick")).toBe("mccormick");
  });
});

describe("corroborateHoldings classification (fixtures only, no network)", () => {
  it("upgrades to corroborated on supporting coverage and appends news sources", async () => {
    const row = holding(); // Biggs IBIT, unverified
    const result = await corroborateHoldings([row], {
      members,
      universe,
      client: client([{ match: "Biggs", body: corroborationFixture() }]),
      now: "2026-07-28",
      lookbackDays: 180,
    });

    const reviewed = result.reviewed[0]!;
    expect(reviewed.verification).toBe("corroborated");
    // The official filing source survives untouched, in first position.
    expect(reviewed.sources[0]).toEqual(row.sources[0]);
    const newsSources = reviewed.sources.filter((s) => s.kind === "news");
    expect(newsSources.length).toBeGreaterThanOrEqual(1);
    expect(newsSources.length).toBeLessThanOrEqual(2);
    for (const s of newsSources) expect(s.url).toMatch(/^https:\/\//);
    // Still a valid Holding per the shared contract.
    expect(() => parseHoldings(result.reviewed)).not.toThrow();
    // First template was conclusive - the second is not spent.
    expect(result.queriesUsed).toBe(1);
    expect(result.queriesSkipped).toBe(0);
    expect(result.skippedHoldings).toBe(0);
    expect(result.issues).toEqual([]);
  });

  it("flags a conflict when the title reports a sale of a row we show as held", async () => {
    const row = holding({
      memberId: "G000603",
      security: { ticker: "BTC", kind: "direct" },
    });
    const evidenceUrl = "https://example-news.com/gill-sells-bitcoin";
    const result = await corroborateHoldings([row], {
      members,
      universe,
      client: client([
        {
          match: "Gill",
          body: exaResponse([
            {
              title: "Brandon Gill sells his entire Bitcoin stake, filing shows",
              url: evidenceUrl,
              publishedDate: "2026-07-20T00:00:00.000Z",
              text: "Rep. Brandon Gill disclosed selling his Bitcoin holdings.",
            },
          ]),
        },
      ]),
      now: "2026-07-28",
    });

    const reviewed = result.reviewed[0]!;
    expect(reviewed.verification).toBe("conflict");
    expect(reviewed.sources.some((s) => s.kind === "news" && s.url === evidenceUrl)).toBe(true);
    expect(reviewed.sources[0]?.kind).toBe("filing");
  });

  it("keeps a no-hit row unverified - absence of news is not a conflict", async () => {
    const row = holding();
    const result = await corroborateHoldings([row], {
      members,
      universe,
      client: client([]), // every query answers with zero results
      now: "2026-07-28",
    });

    expect(result.reviewed[0]).toEqual(row); // untouched, still unverified
    expect(result.reviewed[0]?.verification).toBe("unverified");
    expect(result.queriesUsed).toBe(2); // both templates tried before giving up
    expect(result.issues).toEqual([]);
  });

  it("never downgrades an existing corroborated row on a no-hit day", async () => {
    const row = holding({
      verification: "corroborated",
      sources: [
        {
          kind: "filing",
          url: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20030000.pdf",
        },
        { kind: "news", url: "https://coindesk.com/earlier-coverage" },
      ],
    });
    const result = await corroborateHoldings([row], {
      members,
      universe,
      client: client([]),
      now: "2026-07-28",
    });

    expect(result.reviewed[0]).toEqual(row); // verification and sources intact
  });

  it("escalates corroborated to conflict when contradicting evidence appears", async () => {
    const row = holding({ verification: "corroborated" });
    const result = await corroborateHoldings([row], {
      members,
      universe,
      client: client([
        {
          match: "Biggs",
          body: exaResponse([
            {
              title: "Sheri Biggs sold her IBIT position, new filing shows",
              url: "https://example-news.com/biggs-sold-ibit",
              publishedDate: "2026-07-25T00:00:00.000Z",
              text: "The congresswoman exited the iShares Bitcoin Trust.",
            },
          ]),
        },
      ]),
      now: "2026-07-28",
    });

    expect(result.reviewed[0]?.verification).toBe("conflict");
  });

  it("falls through to the second template when the first is inconclusive", async () => {
    const row = holding();
    const calls: RecordedCall[] = [];
    const result = await corroborateHoldings([row], {
      members,
      universe,
      client: client(
        [
          {
            match: "bought sold", // only the second template gets a hit
            body: exaResponse([
              {
                title: "Rep. Sheri Biggs discloses $250,000 IBIT purchase",
                url: "https://example-news.com/biggs-ibit-buy",
                publishedDate: "2026-04-17T00:00:00.000Z",
                text: "Biggs bought up to $250,000 of the iShares Bitcoin Trust ETF.",
              },
            ]),
          },
        ],
        30,
        calls,
      ),
      now: "2026-07-28",
    });

    expect(result.queriesUsed).toBe(2);
    expect(calls.map((c) => String(c.body.query))).toEqual([
      "Sheri Biggs iShares Bitcoin Trust ETF IBIT disclosure",
      "Sheri Biggs IBIT bought sold",
    ]);
    expect(result.reviewed[0]?.verification).toBe("corroborated");
  });

  it("records an issue and passes the row through when the member is unknown", async () => {
    const row = holding({ memberId: "Z000999" });
    const result = await corroborateHoldings([row], {
      members,
      universe,
      client: client([{ match: "", body: corroborationFixture() }]),
      now: "2026-07-28",
    });

    expect(result.reviewed[0]).toEqual(row);
    expect(result.queriesUsed).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("Z000999");
  });

  it("keeps rows unchanged on per-query HTTP failure and reports the issue", async () => {
    const row = holding();
    const result = await corroborateHoldings([row], {
      members,
      universe,
      client: client([{ match: "Biggs", body: { error: "nope" }, status: 400 }]),
      now: "2026-07-28",
    });

    expect(result.reviewed[0]).toEqual(row);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]).toContain("400");
  });
});

describe("budget exhaustion (reported, never silent)", () => {
  it("reports queriesSkipped and skippedHoldings once the budget runs out", async () => {
    const rows = [
      holding(), // Biggs IBIT - gets the single budgeted query
      holding({ memberId: "G000603", security: { ticker: "BTC", kind: "direct" } }),
      holding({ memberId: "L000571", security: { ticker: "FBTC", kind: "spot-etf" } }),
    ];
    const dropped: string[] = [];
    const result = await corroborateHoldings(rows, {
      members,
      universe,
      client: client([{ match: "Biggs", body: corroborationFixture() }], 1),
      now: "2026-07-28",
      log: (line) => dropped.push(line),
    });

    expect(result.reviewed[0]?.verification).toBe("corroborated");
    // The two unreached rows stay unverified and are counted, not hidden.
    expect(result.reviewed[1]).toEqual(rows[1]);
    expect(result.reviewed[2]).toEqual(rows[2]);
    expect(result.queriesUsed).toBe(1);
    expect(result.queriesSkipped).toBe(2);
    expect(result.skippedHoldings).toBe(2);
    // Every drop is logged.
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toContain("budget exhausted");
  });
});
