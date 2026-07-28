import { describe, expect, it } from "vitest";
import { ExaBudgetError, ExaClient, ExaError } from "../../src/review/index.js";
import {
  corroborationFixture,
  exaFetchFake,
  jsonResponse,
  type RecordedCall,
} from "./helpers.js";

describe("ExaClient (fixture-backed, no network)", () => {
  it("POSTs the typed request with x-api-key and parses a real captured response", async () => {
    const calls: RecordedCall[] = [];
    const client = new ExaClient({
      apiKey: "test-key",
      fetchImpl: exaFetchFake([{ match: "Biggs", body: corroborationFixture() }], calls),
    });
    const response = await client.search({
      query: "Sheri Biggs iShares Bitcoin Trust IBIT disclosure",
      type: "auto",
      numResults: 5,
      startPublishedDate: "2026-01-01T00:00:00.000Z",
      contents: { text: { maxCharacters: 1000 } },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.exa.ai/search");
    expect(calls[0]?.headers["x-api-key"]).toBe("test-key");
    expect(calls[0]?.body.numResults).toBe(5);
    expect(response.results).toHaveLength(5);
    expect(response.results[0]?.url).toMatch(/^https:\/\//);
    expect(response.results[0]?.publishedDate).toBe("2026-04-17T00:00:00.000Z");
  });

  it("retries exactly once on a 5xx and succeeds", async () => {
    let attempts = 0;
    const client = new ExaClient({
      apiKey: "k",
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) return jsonResponse({ error: "upstream" }, 502);
        return jsonResponse({ requestId: "r", results: [] });
      },
    });
    const response = await client.search({ query: "q" });
    expect(attempts).toBe(2);
    expect(response.results).toEqual([]);
    expect(client.queriesUsed).toBe(1); // the retry consumed no extra budget
  });

  it("gives up after the single 5xx retry with a typed http error", async () => {
    let attempts = 0;
    const client = new ExaClient({
      apiKey: "k",
      fetchImpl: async () => {
        attempts += 1;
        return jsonResponse({ error: "down" }, 503);
      },
    });
    const err = await client.search({ query: "q" }).catch((e: unknown) => e);
    expect(attempts).toBe(2);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).code).toBe("http");
    expect((err as ExaError).status).toBe(503);
  });

  it("does not retry a 4xx", async () => {
    let attempts = 0;
    const client = new ExaClient({
      apiKey: "bad",
      fetchImpl: async () => {
        attempts += 1;
        return jsonResponse({ error: "unauthorized" }, 401);
      },
    });
    const err = await client.search({ query: "q" }).catch((e: unknown) => e);
    expect(attempts).toBe(1);
    expect((err as ExaError).code).toBe("http");
    expect((err as ExaError).status).toBe(401);
    expect((err as ExaError).message).toContain("EXA_API_KEY");
  });

  it("rejects a response that is not Exa-shaped", async () => {
    const client = new ExaClient({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ nope: true }),
    });
    const err = await client.search({ query: "q" }).catch((e: unknown) => e);
    expect((err as ExaError).code).toBe("bad-response");
  });

  it("enforces the strict query budget with a typed error", async () => {
    const client = new ExaClient({
      apiKey: "k",
      queryBudget: 2,
      fetchImpl: async () => jsonResponse({ requestId: "r", results: [] }),
    });
    await client.search({ query: "one" });
    await client.search({ query: "two" });
    expect(client.queriesRemaining).toBe(0);
    const err = await client.search({ query: "three" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExaBudgetError);
    expect((err as ExaBudgetError).budget).toBe(2);
    expect(client.queriesUsed).toBe(2); // the refused query consumed nothing
  });

  it("throws a typed error when no API key is available", () => {
    const saved = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    try {
      expect(() => new ExaClient({ fetchImpl: async () => jsonResponse({}) })).toThrowError(
        ExaError,
      );
    } finally {
      if (saved !== undefined) process.env.EXA_API_KEY = saved;
    }
  });
});
