import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fetchKadoaFilerTrades,
  fetchKadoaFilers,
  fetchKadoaPrices,
  fetchKadoaReturns,
  fetchKadoaTickers,
  fetchKadoaTrades,
} from "../../src/kadoa/index.js";
import { fixtureFetchFn } from "./helpers.js";

describe("kadoa fetch layer (fixture-backed, no network)", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "kadoa-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("fetches and validates every dataset", async () => {
    const opts = { cacheDir: null, fetchFn: fixtureFetchFn() };
    const trades = await fetchKadoaTrades(opts);
    expect(trades.length).toBeGreaterThan(100);
    expect(trades[0]?.id).toBeTypeOf("string");

    const filers = await fetchKadoaFilers(opts);
    expect(filers.some((f) => f.full_name === "Brandon Gill")).toBe(true);

    const tickers = await fetchKadoaTickers(opts);
    expect(tickers.some((t) => t.ticker === "MSTR")).toBe(true);

    const returns = await fetchKadoaReturns(opts);
    expect(returns.length).toBeGreaterThan(0);

    const prices = await fetchKadoaPrices(opts);
    expect(Object.keys(prices).length).toBeGreaterThan(0);
  });

  it("fetches per-filer history files", async () => {
    const file = await fetchKadoaFilerTrades("house_brandon_gill", {
      cacheDir: null,
      fetchFn: fixtureFetchFn(),
    });
    expect(file.filer.full_name).toBe("Brandon Gill");
    expect(file.trades.length).toBeGreaterThan(10);
  });

  it("caches on disk and skips refetching while fresh", async () => {
    const calls: string[] = [];
    const opts = { cacheDir, fetchFn: fixtureFetchFn(calls) };
    await fetchKadoaTrades(opts);
    expect(calls).toHaveLength(1);
    await fetchKadoaTrades(opts);
    expect(calls).toHaveLength(1); // served from cache
  });

  it("refetches once the cache is older than maxAgeMs", async () => {
    const calls: string[] = [];
    const opts = { cacheDir, fetchFn: fixtureFetchFn(calls), maxAgeMs: 60_000 };
    await fetchKadoaTrades(opts);
    // Age the cached file beyond maxAgeMs.
    const cached = path.join(cacheDir, "trades.json");
    const old = new Date(Date.now() - 3_600_000);
    await utimes(cached, old, old);
    await fetchKadoaTrades(opts);
    expect(calls).toHaveLength(2);
  });

  it("falls back to a stale cache when the fetch fails", async () => {
    await fetchKadoaTrades({ cacheDir, fetchFn: fixtureFetchFn() });
    const cached = path.join(cacheDir, "trades.json");
    const old = new Date(Date.now() - 3_600_000);
    await utimes(cached, old, old);

    const failing = () => Promise.reject(new Error("network down"));
    const trades = await fetchKadoaTrades({ cacheDir, fetchFn: failing, maxAgeMs: 60_000 });
    expect(trades.length).toBeGreaterThan(100);
  });

  it("throws when the fetch fails and there is no cache", async () => {
    const failing = () => Promise.reject(new Error("network down"));
    await expect(fetchKadoaTrades({ cacheDir, fetchFn: failing })).rejects.toThrow(
      "network down",
    );
  });

  it("returns 404s as errors", async () => {
    await expect(
      fetchKadoaFilerTrades("house_nobody_here", { cacheDir: null, fetchFn: fixtureFetchFn() }),
    ).rejects.toThrow("HTTP 404");
  });
});
