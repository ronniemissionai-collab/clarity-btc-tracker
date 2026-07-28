/**
 * Shared helpers for the returns test-suite. All data comes from committed
 * fixtures (kadoa: live-fetched 2026-07-28; yahoo: live-captured 2026-07-28
 * SPY 3mo chart, trimmed) or is synthesized in-process. No network anywhere.
 */
import { readFileSync } from "node:fs";
import type { Trade } from "@clarity-btc/shared";
import type { YahooFetchFn } from "../../src/returns/index.js";

const YAHOO_FIXTURES_URL = new URL("../fixtures/yahoo/", import.meta.url);

export function readYahooFixtureText(relPath: string): string {
  return readFileSync(new URL(relPath, YAHOO_FIXTURES_URL), "utf8");
}

/** The live-captured, trimmed SPY chart body (2026-04-28 -> 2026-07-27). */
export function spyChartBody(): string {
  return readYahooFixtureText("spy-3mo.json");
}

/** Build a minimal-but-valid v8 chart body for a synthetic symbol. */
export function chartBody(
  symbol: string,
  points: Array<{ date: string; close: number }>,
): string {
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: { symbol },
          timestamp: points.map((p) => Date.parse(`${p.date}T14:30:00Z`) / 1000),
          indicators: { quote: [{ close: points.map((p) => p.close) }] },
        },
      ],
      error: null,
    },
  });
}

/**
 * Yahoo fetch stub serving one body per symbol; records requested URLs.
 * Unknown symbols get a 404.
 */
export function yahooFetchStub(
  bodies: Record<string, string>,
  calls?: string[],
): YahooFetchFn {
  return (url) => {
    calls?.push(url);
    const match = /\/chart\/([^?]+)/.exec(url);
    const symbol = match?.[1] !== undefined ? decodeURIComponent(match[1]) : "";
    const body = bodies[symbol];
    if (body === undefined) {
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
  };
}

/** Trade factory with sensible defaults (buy, priced range, filing URL). */
export function makeTrade(overrides: Partial<Trade> & Pick<Trade, "memberId" | "assetRaw">): Trade {
  return {
    security: null,
    side: "buy",
    range: { lo: 1001, hi: 15000 },
    transactionDate: "2026-05-05",
    filedDate: "2026-05-20",
    docUrl: "https://efdsearch.senate.gov/search/view/ptr/test/",
    late: false,
    ...overrides,
  };
}
