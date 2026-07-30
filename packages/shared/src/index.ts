/**
 * @clarity-btc/shared - the single data contract every module imports.
 *
 * Exports: zod schemas (schemas.ts), inferred TypeScript types, type guards
 * (isX), and parse helpers (parseX / parseXs) that throw on invalid input.
 */
import { z } from "zod";
import type {
  CommonHoldingOwnerSchema,
  PortfolioSecurityKindSchema,
  PortfolioSecurityRefSchema,
  SecurityRefSchema,
  SenateLisMemberVoteSchema,
  SeriesPointSchema,
} from "./schemas.js";
import {
  BillSchema,
  CommonHoldingSchema,
  ExpectationsSchema,
  HoldingSchema,
  MemberSchema,
  MetaSchema,
  NewsItemSchema,
  PortfolioFileSchema,
  PortfolioIndexEntrySchema,
  PortfolioPositionSchema,
  SecuritySchema,
  TradeSchema,
  TraderSchema,
  TradersConfigSchema,
  UniverseConfigSchema,
} from "./schemas.js";

export * from "./schemas.js";

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Member = z.infer<typeof MemberSchema>;
export type Security = z.infer<typeof SecuritySchema>;
export type SecurityRef = z.infer<typeof SecurityRefSchema>;
export type Holding = z.infer<typeof HoldingSchema>;
export type Trade = z.infer<typeof TradeSchema>;
export type Bill = z.infer<typeof BillSchema>;
export type SenateLisMemberVote = z.infer<typeof SenateLisMemberVoteSchema>;
export type Trader = z.infer<typeof TraderSchema>;
export type NewsItem = z.infer<typeof NewsItemSchema>;
export type Meta = z.infer<typeof MetaSchema>;
export type UniverseConfig = z.infer<typeof UniverseConfigSchema>;
export type TradersConfig = z.infer<typeof TradersConfigSchema>;
export type Expectations = z.infer<typeof ExpectationsSchema>;

export type SeriesPoint = z.infer<typeof SeriesPointSchema>;
export type PortfolioSecurityKind = z.infer<typeof PortfolioSecurityKindSchema>;
export type PortfolioSecurityRef = z.infer<typeof PortfolioSecurityRefSchema>;
export type PortfolioPosition = z.infer<typeof PortfolioPositionSchema>;
export type PortfolioIndexEntry = z.infer<typeof PortfolioIndexEntrySchema>;
export type PortfolioFile = z.infer<typeof PortfolioFileSchema>;

export type CommonHoldingOwner = z.infer<typeof CommonHoldingOwnerSchema>;
export type CommonHolding = z.infer<typeof CommonHoldingSchema>;

export type Party = Member["party"];
export type Chamber = Member["chamber"];
export type SecurityKind = Security["kind"];
export type ValueRange = Holding["range"];

// ---------------------------------------------------------------------------
// Security key helper (key = ticker + kind; disambiguates the two "BTC"s)
// ---------------------------------------------------------------------------

export type SecurityKey = `${string}:${PortfolioSecurityKind}`;

/**
 * Composite key for a security: "BTC:direct" vs "BTC:spot-etf" are distinct.
 * Accepts portfolio refs too (non-universe securities key as "AAPL:other").
 */
export function securityKey(ref: SecurityRef | PortfolioSecurityRef): SecurityKey {
  return `${ref.ticker}:${ref.kind}`;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export const isMember = (v: unknown): v is Member => MemberSchema.safeParse(v).success;
export const isSecurity = (v: unknown): v is Security => SecuritySchema.safeParse(v).success;
export const isHolding = (v: unknown): v is Holding => HoldingSchema.safeParse(v).success;
export const isTrade = (v: unknown): v is Trade => TradeSchema.safeParse(v).success;
export const isBill = (v: unknown): v is Bill => BillSchema.safeParse(v).success;
export const isTrader = (v: unknown): v is Trader => TraderSchema.safeParse(v).success;
export const isNewsItem = (v: unknown): v is NewsItem => NewsItemSchema.safeParse(v).success;
export const isMeta = (v: unknown): v is Meta => MetaSchema.safeParse(v).success;

// ---------------------------------------------------------------------------
// Parse helpers (throw ZodError on invalid input)
// ---------------------------------------------------------------------------

export const parseMember = (v: unknown): Member => MemberSchema.parse(v);
export const parseMembers = (v: unknown): Member[] => z.array(MemberSchema).parse(v);
export const parseSecurity = (v: unknown): Security => SecuritySchema.parse(v);
export const parseHolding = (v: unknown): Holding => HoldingSchema.parse(v);
export const parseHoldings = (v: unknown): Holding[] => z.array(HoldingSchema).parse(v);
export const parseTrade = (v: unknown): Trade => TradeSchema.parse(v);
export const parseTrades = (v: unknown): Trade[] => z.array(TradeSchema).parse(v);
export const parseBill = (v: unknown): Bill => BillSchema.parse(v);
export const parseTrader = (v: unknown): Trader => TraderSchema.parse(v);
export const parseTraders = (v: unknown): Trader[] => z.array(TraderSchema).parse(v);
export const parseNews = (v: unknown): NewsItem[] => z.array(NewsItemSchema).parse(v);
export const parseMeta = (v: unknown): Meta => MetaSchema.parse(v);

export const parseUniverseConfig = (v: unknown): UniverseConfig => UniverseConfigSchema.parse(v);
export const parseTradersConfig = (v: unknown): TradersConfig => TradersConfigSchema.parse(v);
export const parseExpectations = (v: unknown): Expectations => ExpectationsSchema.parse(v);

export const parsePortfolioPosition = (v: unknown): PortfolioPosition =>
  PortfolioPositionSchema.parse(v);
export const parsePortfolioIndex = (v: unknown): PortfolioIndexEntry[] =>
  z.array(PortfolioIndexEntrySchema).parse(v);
export const parsePortfolioFile = (v: unknown): PortfolioFile => PortfolioFileSchema.parse(v);

export const parseCommonHolding = (v: unknown): CommonHolding => CommonHoldingSchema.parse(v);
export const parseCommonHoldings = (v: unknown): CommonHolding[] =>
  z.array(CommonHoldingSchema).parse(v);
