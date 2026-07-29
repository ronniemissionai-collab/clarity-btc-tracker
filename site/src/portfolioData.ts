/**
 * Lazy-loaded v1.1 portfolio data (spec §v1.1 — Full portfolios):
 *
 *   /data/portfolio/index.json       — the member directory
 *   /data/portfolio/{memberId}.json  — one member's full portfolio
 *
 * These files are fetched on demand (never bundled — the full trade set is
 * ~16MB) and validated before rendering: nested Member/Holding/Trade rows go
 * through the shared-contract schemas; the wrapper shapes are validated by
 * hand here until @clarity-btc/shared ships them (pipeline ticket 14 owns
 * the emission side of this contract).
 */
import {
  MeasuredPerformanceSchema,
  parseHoldings,
  parseMember,
  parseTrades,
  type Chamber,
  type Holding,
  type Member,
  type Party,
  type Trade,
  type Trader,
} from "@clarity-btc/shared";
import { parseSparkSeries } from "./data";
import type { SparkPoint } from "./components/sparkline";

/** One row of data/portfolio/index.json — the "All traders" directory. */
export interface DirectoryEntry {
  memberId: string;
  name: string;
  party: Party;
  chamber: Chamber;
  state: string;
  active: boolean;
  tradeCount: number;
  lastTradeDate: string;
  /** Member of the curated portfolio-tracker roster (has a trader card). */
  rosterMember: boolean;
}

/** data/portfolio/{memberId}.json — one member's full portfolio. */
export interface MemberPortfolio {
  member: Member;
  /** Unfiltered all-ticker positions, same epistemics/schema as holdings.json. */
  positions: Holding[];
  /** Full disclosed trade history, newest first. */
  trades: Trade[];
  /** Range-midpoint points over time (the member-page sparkline series). */
  series: SparkPoint[];
  /** Null until the returns step has priced the member's disclosed buys. */
  measured: Trader["measured"];
}

const BIOGUIDE = /^[A-Z]\d{6}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PARTIES: readonly string[] = ["R", "D", "I"];
const CHAMBERS: readonly string[] = ["house", "senate"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function parseDirectoryEntry(raw: unknown, context: string): DirectoryEntry {
  if (!isRecord(raw)) fail(context, "entry must be an object");
  const {
    memberId,
    name,
    party,
    chamber,
    state,
    active,
    tradeCount,
    lastTradeDate,
    rosterMember,
  } = raw;
  if (typeof memberId !== "string" || !BIOGUIDE.test(memberId)) {
    fail(context, "memberId must be a bioguide-style id");
  }
  if (typeof name !== "string" || name.length === 0) fail(context, "name must be a non-empty string");
  if (typeof party !== "string" || !PARTIES.includes(party)) fail(context, "party must be R, D or I");
  if (typeof chamber !== "string" || !CHAMBERS.includes(chamber)) {
    fail(context, "chamber must be house or senate");
  }
  if (typeof state !== "string" || state.length !== 2) fail(context, "state must be a 2-letter code");
  if (typeof active !== "boolean") fail(context, "active must be a boolean");
  if (typeof tradeCount !== "number" || !Number.isInteger(tradeCount) || tradeCount < 0) {
    fail(context, "tradeCount must be a nonnegative integer");
  }
  if (typeof lastTradeDate !== "string" || !ISO_DATE.test(lastTradeDate)) {
    fail(context, "lastTradeDate must be an ISO date");
  }
  if (typeof rosterMember !== "boolean") fail(context, "rosterMember must be a boolean");
  return {
    memberId,
    name,
    party: party as Party,
    chamber: chamber as Chamber,
    state,
    active,
    tradeCount,
    lastTradeDate,
    rosterMember,
  };
}

export function parseDirectory(raw: unknown): DirectoryEntry[] {
  if (!Array.isArray(raw)) throw new Error("portfolio/index.json: expected an array");
  return raw.map((entry, i) => parseDirectoryEntry(entry, `portfolio/index.json[${i}]`));
}

export function parsePortfolio(raw: unknown, memberId: string): MemberPortfolio {
  const context = `portfolio/${memberId}.json`;
  if (!isRecord(raw)) fail(context, "expected an object");
  const portfolio: MemberPortfolio = {
    member: parseMember(raw["member"]),
    positions: parseHoldings(raw["positions"]),
    trades: parseTrades(raw["trades"]),
    series: parseSparkSeries(raw["series"], context),
    measured: raw["measured"] === null ? null : MeasuredPerformanceSchema.parse(raw["measured"]),
  };
  if (portfolio.member.bioguideId !== memberId) {
    fail(context, `member.bioguideId is ${portfolio.member.bioguideId}, expected ${memberId}`);
  }
  return portfolio;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetch ${url}: HTTP ${response.status}`);
  }
  return (await response.json()) as unknown;
}

let directoryCache: DirectoryEntry[] | null = null;
const portfolioCache = new Map<string, MemberPortfolio>();

/** Lazy directory fetch — cached after the first successful load. */
export async function fetchDirectory(): Promise<DirectoryEntry[]> {
  if (directoryCache === null) {
    directoryCache = parseDirectory(await fetchJson("/data/portfolio/index.json"));
  }
  return directoryCache;
}

/** Lazy member-portfolio fetch — cached per member after the first load. */
export async function fetchPortfolio(memberId: string): Promise<MemberPortfolio> {
  if (!BIOGUIDE.test(memberId)) {
    throw new Error(`"${memberId}" is not a valid member id`);
  }
  const cached = portfolioCache.get(memberId);
  if (cached) return cached;
  const portfolio = parsePortfolio(
    await fetchJson(`/data/portfolio/${encodeURIComponent(memberId)}.json`),
    memberId,
  );
  portfolioCache.set(memberId, portfolio);
  return portfolio;
}
