import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOnOrAfter,
  createYahooClient,
  latestClose,
  parseYahooChart,
  PriceFetchError,
  PriceParseError,
  PriceUnavailableError,
} from "../../src/returns/index.js";
import { chartBody, spyChartBody, yahooFetchStub } from "./helpers.js";

describe("parseYahooChart", () => {
  it("parses the live-captured SPY fixture into an ascending daily series", () => {
    const series = parseYahooChart("SPY", spyChartBody());
    expect(series.symbol).toBe("SPY");
    expect(series.points).toHaveLength(62);
    expect(series.points[0]).toEqual({ date: "2026-04-28", close: 709.8612060546875 });
    expect(series.points[series.points.length - 1]?.date).toBe("2026-07-27");
    for (let i = 1; i < series.points.length; i++) {
      expect(series.points[i]!.date > series.points[i - 1]!.date).toBe(true);
    }
  });

  it("prefers dividend-adjusted closes over raw closes", () => {
    // In the fixture 2026-04-28 raw close is 711.69; adjclose is 709.861...
    const series = parseYahooChart("SPY", spyChartBody());
    expect(series.points[0]?.close).toBeCloseTo(709.8612060546875, 6);
    expect(series.points[0]?.close).not.toBeCloseTo(711.69, 1);
  });

  it("falls back to raw closes when adjclose is absent and skips null slots", () => {
    const body = JSON.stringify({
      chart: {
        result: [
          {
            meta: { symbol: "SYN" },
            timestamp: [
              Date.parse("2026-05-04T14:30:00Z") / 1000,
              Date.parse("2026-05-05T14:30:00Z") / 1000,
              Date.parse("2026-05-06T14:30:00Z") / 1000,
            ],
            indicators: { quote: [{ close: [100, null, 110] }] },
          },
        ],
        error: null,
      },
    });
    const series = parseYahooChart("SYN", body);
    expect(series.points).toEqual([
      { date: "2026-05-04", close: 100 },
      { date: "2026-05-06", close: 110 },
    ]);
  });

  it("throws PriceUnavailableError on a chart error payload", () => {
    const body = JSON.stringify({
      chart: { result: null, error: { code: "Not Found", description: "No data found" } },
    });
    expect(() => parseYahooChart("NOPE", body)).toThrow(PriceUnavailableError);
  });

  it("throws PriceParseError on a non-JSON body", () => {
    expect(() => parseYahooChart("SPY", "<html>challenge</html>")).toThrow(PriceParseError);
  });
});

describe("series helpers", () => {
  const series = parseYahooChart("SPY", spyChartBody());

  it("closeOnOrAfter rolls a weekend trade date to the next session", () => {
    // 2026-05-02 is a Saturday; the next close in the fixture is Monday 05-04.
    expect(closeOnOrAfter(series, "2026-05-02")).toEqual({
      date: "2026-05-04",
      close: 716.1649780273438,
    });
    expect(closeOnOrAfter(series, "2026-05-05")?.date).toBe("2026-05-05");
    expect(closeOnOrAfter(series, "2027-01-01")).toBeUndefined();
  });

  it("latestClose returns the newest point", () => {
    expect(latestClose(series)).toEqual({ date: "2026-07-27", close: 739.0900268554688 });
  });
});

describe("createYahooClient", () => {
  const cacheDirs: string[] = [];
  const newCacheDir = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), "yahoo-cache-"));
    cacheDirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of cacheDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("sends a browser User-Agent and hits the v8 chart URL", async () => {
    const calls: string[] = [];
    let seenHeaders: Record<string, string> = {};
    const client = createYahooClient({
      cacheDir: null,
      fetchFn: (url, headers) => {
        seenHeaders = headers;
        return yahooFetchStub({ SPY: spyChartBody() }, calls)(url, headers);
      },
    });
    await client.dailySeries("SPY");
    expect(calls[0]).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=2y&interval=1d",
    );
    expect(seenHeaders["User-Agent"]).toMatch(/^Mozilla\/5\.0 /);
  });

  it("memoizes per symbol in memory - one request per symbol per run", async () => {
    const calls: string[] = [];
    const client = createYahooClient({
      cacheDir: null,
      fetchFn: yahooFetchStub({ SPY: spyChartBody() }, calls),
    });
    const [a, b] = await Promise.all([client.dailySeries("SPY"), client.dailySeries("SPY")]);
    await client.dailySeries("SPY");
    expect(calls).toHaveLength(1);
    expect(a.points).toEqual(b.points);
  });

  it("reuses the disk cache across client instances without refetching", async () => {
    const cacheDir = newCacheDir();
    const calls: string[] = [];
    const first = createYahooClient({
      cacheDir,
      fetchFn: yahooFetchStub({ SPY: spyChartBody() }, calls),
    });
    await first.dailySeries("SPY");
    expect(calls).toHaveLength(1);

    const second = createYahooClient({
      cacheDir,
      fetchFn: yahooFetchStub({}, calls), // would 404 if it actually fetched
    });
    const series = await second.dailySeries("SPY");
    expect(calls).toHaveLength(1);
    expect(series.points).toHaveLength(62);
  });

  it("serves a stale disk cache when the network fails", async () => {
    const cacheDir = newCacheDir();
    await createYahooClient({
      cacheDir,
      fetchFn: yahooFetchStub({ SPY: spyChartBody() }),
    }).dailySeries("SPY");

    const offline = createYahooClient({
      cacheDir,
      maxAgeMs: 0, // force the cache stale
      fetchFn: () => Promise.reject(new Error("network down")),
    });
    const series = await offline.dailySeries("SPY");
    expect(series.points).toHaveLength(62);
  });

  it("throws PriceFetchError with the status on an HTTP failure", async () => {
    const client = createYahooClient({
      cacheDir: null,
      fetchFn: () =>
        Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve("rate limited") }),
    });
    const err = await client.dailySeries("SPY").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PriceFetchError);
    expect((err as PriceFetchError).status).toBe(429);
    expect((err as PriceFetchError).code).toBe("http");
  });

  it("does not memoize failures", async () => {
    let attempts = 0;
    const client = createYahooClient({
      cacheDir: null,
      fetchFn: (url, headers) => {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error("flaky"));
        return yahooFetchStub({ SPY: spyChartBody() })(url, headers);
      },
    });
    await expect(client.dailySeries("SPY")).rejects.toBeInstanceOf(PriceFetchError);
    const series = await client.dailySeries("SPY");
    expect(series.points).toHaveLength(62);
    expect(attempts).toBe(2);
  });

  it("uses a custom range in URL and cache key", async () => {
    const calls: string[] = [];
    const client = createYahooClient({
      cacheDir: null,
      range: "3mo",
      fetchFn: yahooFetchStub({ SPCX: chartBody("SPCX", [{ date: "2026-06-12", close: 150 }]) }, calls),
    });
    await client.dailySeries("SPCX");
    expect(calls[0]).toContain("/chart/SPCX?range=3mo&interval=1d");
  });
});
