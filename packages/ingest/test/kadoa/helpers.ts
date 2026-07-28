/**
 * Shared loaders for the kadoa test-suite. All data comes from committed
 * fixtures (live-fetched 2026-07-28 from kadoa-org/congress-trading-monitor,
 * MIT) and the repo's own config/data files. No network anywhere.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  parseMembers,
  parseUniverseConfig,
  type Member,
  type Security,
} from "@clarity-btc/shared";
import {
  KadoaFilerFileSchema,
  KadoaFilerSchema,
  KadoaTradeRowSchema,
  type KadoaFetchFn,
  type KadoaFiler,
  type KadoaFilerFile,
  type KadoaTradeRow,
} from "../../src/kadoa/index.js";

const FIXTURES_URL = new URL("../fixtures/kadoa/", import.meta.url);

export function readFixtureText(relPath: string): string {
  return readFileSync(new URL(relPath, FIXTURES_URL), "utf8");
}

export function readFixtureJson(relPath: string): unknown {
  return JSON.parse(readFixtureText(relPath)) as unknown;
}

export function loadTradesFixture(): KadoaTradeRow[] {
  return z.array(KadoaTradeRowSchema).parse(readFixtureJson("trades.json"));
}

export function loadFilersFixture(): KadoaFiler[] {
  return z.array(KadoaFilerSchema).parse(readFixtureJson("filers.json"));
}

export function loadFilerFileFixture(filerId: string): KadoaFilerFile {
  return KadoaFilerFileSchema.parse(readFixtureJson(`filer/${filerId}.json`));
}

export function loadMembers(): Member[] {
  const raw = readFileSync(new URL("../../../../data/members.json", import.meta.url), "utf8");
  return parseMembers(JSON.parse(raw));
}

export function loadUniverse(): Security[] {
  const raw = readFileSync(new URL("../../../../config/universe.json", import.meta.url), "utf8");
  return parseUniverseConfig(JSON.parse(raw)).universe;
}

/**
 * fetchFn stub that serves committed fixtures by URL suffix and records the
 * URLs requested. Unknown paths get a 404 response.
 */
export function fixtureFetchFn(calls?: string[]): KadoaFetchFn {
  return (url: string) => {
    calls?.push(url);
    const relPath = url.split("/public/data/")[1] ?? url.split("kadoa/")[1] ?? "";
    try {
      const body = readFixtureText(relPath);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
    } catch {
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });
    }
  };
}
