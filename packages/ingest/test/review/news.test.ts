import { describe, expect, it } from "vitest";
import { parseNews } from "@clarity-btc/shared";
import {
  buildNewsStrip,
  dedupeAndCap,
  ExaClient,
  reviewWithExa,
  toNewsItem,
} from "../../src/review/index.js";
import {
  corroborationFixture,
  exaFetchFake,
  exaResponse,
  holding,
  members,
  newsFixture,
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

describe("news strip (fixtures only, no network)", () => {
  it("maps a real captured response to NewsItems: title, url, source domain, date", async () => {
    const result = await buildNewsStrip({
      client: client([{ match: "CLARITY", body: newsFixture() }]),
      queries: ["CLARITY Act crypto market structure bill congress bitcoin news"],
      now: "2026-07-28",
    });

    expect(() => parseNews(result.news)).not.toThrow();
    // 8 fixture results, capped at 6.
    expect(result.news).toHaveLength(6);
    // Sorted newest first: the 2026-07-28 item leads.
    expect(result.news[0]?.publishedAt).toBe("2026-07-28");
    const dates = result.news.map((n) => n.publishedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    // Source is the bare domain, www stripped.
    const coindesk = result.news.find((n) => n.url.includes("coindesk.com"));
    expect(coindesk?.source).toBe("coindesk.com");
    expect(result.queriesUsed).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it("dedupes by URL across queries", async () => {
    const dupe = exaResponse([
      {
        title: "Same story",
        url: "https://example.com/story",
        publishedDate: "2026-07-25T00:00:00.000Z",
      },
      {
        title: "Other story",
        url: "https://example.com/other",
        publishedDate: "2026-07-24T00:00:00.000Z",
      },
    ]);
    const result = await buildNewsStrip({
      client: client([
        { match: "alpha", body: dupe },
        { match: "beta", body: dupe },
      ]),
      queries: ["alpha", "beta"],
      now: "2026-07-28",
    });

    expect(result.news.map((n) => n.url)).toEqual([
      "https://example.com/story",
      "https://example.com/other",
    ]);
    expect(result.queriesUsed).toBe(2);
  });

  it("drops results without a title or publish date instead of fabricating", () => {
    expect(
      toNewsItem({ title: null, url: "https://example.com/a", publishedDate: "2026-07-01" }),
    ).toBeNull();
    expect(toNewsItem({ title: "No date", url: "https://example.com/b" })).toBeNull();
    expect(toNewsItem({ title: "Bad url", url: "not-a-url", publishedDate: "2026-07-01" })).toBeNull();
    expect(
      toNewsItem({
        title: "Good",
        url: "https://www.example.com/c",
        publishedDate: "2026-07-21T17:30:58.000Z",
      }),
    ).toEqual({
      title: "Good",
      url: "https://www.example.com/c",
      source: "example.com",
      publishedAt: "2026-07-21",
    });
  });

  it("caps after dedupe and keeps the newest items", () => {
    const items = Array.from({ length: 9 }, (_, i) => ({
      title: `Story ${i}`,
      url: `https://example.com/${i}`,
      source: "example.com",
      publishedAt: `2026-07-${String(10 + i).padStart(2, "0")}`,
    }));
    const capped = dedupeAndCap(items, 6);
    expect(capped).toHaveLength(6);
    expect(capped[0]?.publishedAt).toBe("2026-07-18");
    expect(capped[5]?.publishedAt).toBe("2026-07-13");
  });

  it("reports skipped news queries when the budget is exhausted", async () => {
    const dropped: string[] = [];
    const exhausted = client([], 1);
    await exhausted.search({ query: "warm-up" }); // spend the whole budget
    const result = await buildNewsStrip({
      client: exhausted,
      queries: ["alpha", "beta"],
      now: "2026-07-28",
      log: (line) => dropped.push(line),
    });

    expect(result.news).toEqual([]);
    expect(result.queriesUsed).toBe(0);
    expect(result.queriesSkipped).toBe(2);
    expect(dropped).toHaveLength(2);
  });
});

describe("reviewWithExa orchestration", () => {
  it("shares one budget across news and corroboration and reports totals", async () => {
    const calls: RecordedCall[] = [];
    const result = await reviewWithExa({
      holdings: [holding()],
      members,
      universe,
      apiKey: "test-key",
      fetchImpl: exaFetchFake(
        [
          { match: "CLARITY Act", body: newsFixture() },
          { match: "Biggs", body: corroborationFixture() },
        ],
        calls,
      ),
      queryBudget: 30,
      now: "2026-07-28",
    });

    // 2 default news queries + 1 conclusive corroboration query.
    expect(result.queriesUsed).toBe(3);
    expect(result.queriesSkipped).toBe(0);
    expect(result.skippedHoldings).toBe(0);
    expect(result.news.length).toBeGreaterThan(0);
    expect(result.news.length).toBeLessThanOrEqual(6);
    expect(result.reviewed[0]?.verification).toBe("corroborated");
    // News queries carry the recent-days filter and news category.
    const newsCall = calls[0]!;
    expect(newsCall.body.category).toBe("news");
    expect(newsCall.body.startPublishedDate).toBe("2026-07-14T00:00:00.000Z");
  });

  it("news strip queries run before corroboration can drain the budget", async () => {
    // Budget 2: exactly the news set - every holding query is skipped+reported.
    const result = await reviewWithExa({
      holdings: [holding(), holding({ memberId: "G000603" })],
      members,
      universe,
      apiKey: "test-key",
      fetchImpl: exaFetchFake([{ match: "CLARITY Act", body: newsFixture() }]),
      queryBudget: 2,
      now: "2026-07-28",
    });

    expect(result.news.length).toBeGreaterThan(0);
    expect(result.queriesUsed).toBe(2);
    expect(result.queriesSkipped).toBe(2);
    expect(result.skippedHoldings).toBe(2);
    expect(result.reviewed.every((h) => h.verification === "unverified")).toBe(true);
  });
});
