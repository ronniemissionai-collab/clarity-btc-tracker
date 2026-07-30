/**
 * Zod schemas for the clarity-btc-tracker data contract.
 *
 * Schema source of truth: research ticket 05 (data model), locked 2026-07-28.
 * Core entities: Member, Security, Holding, Trade, Bill, Trader.
 * Supporting shapes: NewsItem (data/news.json) and Meta (data/meta.json), plus
 * the three config files (universe, traders roster, validation expectations).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO calendar date, e.g. "2026-07-17". */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected ISO date YYYY-MM-DD");

/** ISO datetime with timezone, e.g. "2026-07-28T06:00:00Z". */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const PartySchema = z.enum(["R", "D", "I"]);
export const ChamberSchema = z.enum(["house", "senate"]);

/**
 * STOCK Act disclosures report value bands, never exact amounts.
 * Ranges aggregate by summing lo and hi separately; always display as ranges.
 */
export const ValueRangeSchema = z
  .object({
    lo: z.number().nonnegative(),
    hi: z.number().nonnegative(),
  })
  .refine((r) => r.hi >= r.lo, { message: "range hi must be >= lo" });

// ---------------------------------------------------------------------------
// Member
// ---------------------------------------------------------------------------

export const MemberSchema = z.object({
  /** Bioguide-style id, e.g. "P000197". */
  bioguideId: z.string().regex(/^[A-Z]\d{6}$/, "expected bioguide-style id"),
  /** Senate LIS member id, e.g. "S428" (senators only; the LIS vote feed has no bioguide ids). */
  lisId: z.string().optional(),
  name: z.string().min(1),
  party: PartySchema,
  chamber: ChamberSchema,
  /** Two-letter state code. */
  state: z.string().length(2),
  /** House district like "TX-26"; omitted for senators / at-large edge cases. */
  district: z.string().optional(),
  /** Roster corrections (resignations etc.) live here, e.g. MTG resigned 2026-01-05. */
  active: z.boolean(),
  /** Membership in the config/traders.json portfolio-tracker roster. */
  traderRoster: z.enum(["active", "watch"]).optional(),
  note: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Security (key = ticker + kind; resolves the Grayscale-mini "BTC" collision)
// ---------------------------------------------------------------------------

export const SecurityKindSchema = z.enum([
  "direct",
  "spot-etf",
  "treasury",
  "miner",
  "exchange",
  "futures-etf",
]);

export const SecuritySchema = z.object({
  ticker: z.string().min(1),
  name: z.string().min(1),
  tier: z.union([z.literal(1), z.literal(2)]),
  kind: SecurityKindSchema,
  /** Aliases for non-ticker filing text ("Bitcoin", "BTC-USD", retired tickers). */
  aliases: z.array(z.string()).optional(),
  note: z.string().optional(),
  source: z.string().optional(),
});

/** Reference to a security by its composite key parts. */
export const SecurityRefSchema = z.object({
  ticker: z.string().min(1),
  kind: SecurityKindSchema,
});

// ---------------------------------------------------------------------------
// Holding
// ---------------------------------------------------------------------------

export const OwnerSchema = z.enum(["self", "spouse", "dependent", "joint", "trust"]);
export const HoldingStatusSchema = z.enum(["holds", "sold", "stale"]);
export const ExtractionSchema = z.enum(["efd-html", "pdf-text", "pdf-ocr"]);
export const VerificationSchema = z.enum(["unverified", "corroborated", "conflict"]);

export const SourceRefSchema = z.object({
  kind: z.enum(["filing", "news"]),
  url: z.string().url(),
  title: z.string().optional(),
});

export const HoldingSchema = z.object({
  memberId: z.string().regex(/^[A-Z]\d{6}$/),
  security: SecurityRefSchema,
  owner: OwnerSchema,
  range: ValueRangeSchema,
  status: HoldingStatusSchema,
  /** Date the row was last confirmed/derived from a filing. */
  asOf: IsoDateSchema,
  extraction: ExtractionSchema,
  verification: VerificationSchema,
  /** Every row links its official filing or it doesn't ship. */
  sources: z
    .array(SourceRefSchema)
    .min(1)
    .refine((srcs) => srcs.some((s) => s.kind === "filing"), {
      message: "official filing URL is mandatory (at least one source with kind 'filing')",
    }),
  note: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Trade (generic: any ticker, not just the BTC universe)
// ---------------------------------------------------------------------------

export const TradeSideSchema = z.enum(["buy", "sell"]);

export const TradeSchema = z.object({
  memberId: z.string().regex(/^[A-Z]\d{6}$/),
  /** Verbatim asset text from the filing. */
  assetRaw: z.string().min(1),
  /** Resolved security key parts; null when the asset maps to nothing in the universe (e.g. options legs). */
  security: SecurityRefSchema.nullable(),
  side: TradeSideSchema,
  owner: OwnerSchema.optional(),
  range: ValueRangeSchema,
  transactionDate: IsoDateSchema,
  filedDate: IsoDateSchema,
  /** Official filing document URL (Clerk PTR PDF / eFD filing page). */
  docUrl: z.string().url(),
  /** Filed outside the STOCK Act 45-day window. */
  late: z.boolean(),
  note: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Bill (text versions and vote types modeled distinctly: cloture != passage,
// Senate substitute != House-passed text)
// ---------------------------------------------------------------------------

export const BillStageStatusSchema = z.enum(["done", "current", "pending"]);

export const BillStageSchema = z.object({
  label: z.string().min(1),
  date: IsoDateSchema.nullable(),
  status: BillStageStatusSchema,
  detail: z.string().optional(),
});

export const BillTextVersionSchema = z.object({
  /** Congress.gov version code: IH, EH, EAS, or "ANS" for a committee substitute. */
  version: z.string().min(1),
  label: z.string().min(1),
  chamber: ChamberSchema.optional(),
  date: IsoDateSchema,
  url: z.string().url(),
});

export const VoteTypeSchema = z.enum(["passage", "cloture", "committee"]);

export const PartyTallySchema = z.object({
  yea: z.number().int().nonnegative(),
  nay: z.number().int().nonnegative(),
  present: z.number().int().nonnegative().optional(),
  notVoting: z.number().int().nonnegative().optional(),
});

export const MemberVoteSchema = z.object({
  bioguideId: z.string().regex(/^[A-Z]\d{6}$/),
  vote: z.enum(["yea", "nay", "present", "not-voting"]),
});

/**
 * Per-member Senate vote keyed by LIS member id ("S428"), NOT bioguide - the
 * Senate LIS feed does not carry bioguide ids, so Senate breakdowns ship on
 * this parallel shape instead of `memberVotes` (promoted at integration,
 * build ticket 11).
 */
export const SenateLisMemberVoteSchema = z.object({
  /** LIS member id, e.g. "S428". */
  lisMemberId: z.string().min(1),
  /** Display form as published by LIS, e.g. "Alsobrooks (D-MD)". */
  name: z.string().min(1),
  party: z.string().min(1),
  state: z.string().min(1),
  vote: z.enum(["yea", "nay", "present", "not-voting"]),
});

export const BillVoteSchema = z.object({
  type: VoteTypeSchema,
  chamber: ChamberSchema,
  date: IsoDateSchema,
  question: z.string().min(1),
  result: z.enum(["passed", "failed"]),
  yea: z.number().int().nonnegative(),
  nay: z.number().int().nonnegative(),
  present: z.number().int().nonnegative().optional(),
  notVoting: z.number().int().nonnegative().optional(),
  rollUrl: z.string().url(),
  byParty: z.record(z.string(), PartyTallySchema).optional(),
  /** Per-member breakdown; optional in fixtures, populated by the ingest step. */
  memberVotes: z.array(MemberVoteSchema).optional(),
  /** Senate per-member breakdown (LIS ids - the LIS feed has no bioguide ids). */
  senateMemberVotes: z.array(SenateLisMemberVoteSchema).optional(),
});

export const RelatedBillSchema = z.object({
  title: z.string().min(1),
  number: z.string().optional(),
  url: z.string().url(),
  note: z.string().optional(),
});

export const BillSchema = z.object({
  congress: z.number().int(),
  billType: z.string().min(1),
  number: z.number().int(),
  title: z.string().min(1),
  shortTitle: z.string().optional(),
  introducedDate: IsoDateSchema,
  sponsor: z
    .object({ name: z.string(), party: PartySchema, state: z.string() })
    .optional(),
  latestAction: z.object({ date: IsoDateSchema, text: z.string().min(1) }),
  /**
   * Non-negotiable copy hook: "Passed Senate" must never render as the House
   * text becoming law. The Senate text is a full strike-and-replace substitute.
   */
  substituteWarning: z.string().optional(),
  /**
   * True once the Senate has passed its substitute text and the House has not
   * yet re-passed the amended bill (promoted from BillMilestones, ticket 11).
   */
  requiresHouseRepassage: z.boolean().optional(),
  stages: z.array(BillStageSchema).min(1),
  textVersions: z.array(BillTextVersionSchema),
  votes: z.array(BillVoteSchema),
  relatedBills: z.array(RelatedBillSchema),
  asOf: IsoDateSchema,
});

// ---------------------------------------------------------------------------
// Trader (portfolio tracker view)
// ---------------------------------------------------------------------------

export const ClaimSchema = z.object({
  /** Quoted and attributed, never asserted. */
  quote: z.string().min(1),
  sourceUrl: z.string().url(),
  attribution: z.string().optional(),
});

export const MeasuredPerformanceSchema = z.object({
  /** Mean since-trade return on disclosed buys, percent (e.g. 16.8 = +16.8%). */
  return: z.number(),
  /** Excess vs the benchmark, percentage points. */
  excess: z.number().optional(),
  method: z.literal("midpoint"),
  benchmark: z.literal("SPY"),
  window: z.string().optional(),
  asOf: IsoDateSchema.optional(),
  note: z.string().optional(),
});

/**
 * One sparkline point: a disclosed-range midpoint (USD) on a trade date.
 * Midpoints are ESTIMATES - filings disclose value bands, never amounts.
 */
export const SeriesPointSchema = z.object({
  date: IsoDateSchema,
  value: z.number(),
});

export const TraderSchema = z.object({
  memberId: z.string().regex(/^[A-Z]\d{6}$/),
  tradeCount: z.number().int().nonnegative(),
  claims: z.array(ClaimSchema),
  /** Null until the returns step has priced the member's disclosed buys. */
  measured: MeasuredPerformanceSchema.nullable(),
  /**
   * v1.1: precomputed trader-card sparkline - range-midpoint points from the
   * returns computations, ascending by trade date. Optional: pre-v1.1
   * rows/fixtures omit it (the site then falls back to trades.json).
   */
  series: z.array(SeriesPointSchema).optional(),
  /** Whose trades these are: "self", "spouse (Paul Pelosi)", "family trusts", ... */
  attribution: z.string().min(1),
  /**
   * Whether the measured returns support the numeric return claims quoted for
   * this trader (sign-level agreement only - claim windows differ from the
   * measured since-trade window). Omitted when no claim states a number or
   * nothing was measured; false renders the "reputation not supported by
   * filings" chip.
   */
  claimsSupported: z.boolean().optional(),
  note: z.string().optional(),
});

// ---------------------------------------------------------------------------
// v1.1 per-member portfolios (data/portfolio/) - spec "v1.1 - Full portfolios"
// ---------------------------------------------------------------------------

/**
 * Portfolios cover EVERY disclosed ticker, not just the BTC universe. A
 * security outside config/universe.json carries kind "other"; the core
 * SecurityKindSchema stays untouched, so holdings.json remains universe-only.
 */
export const PortfolioSecurityKindSchema = z.union([SecurityKindSchema, z.literal("other")]);

export const PortfolioSecurityRefSchema = z.object({
  ticker: z.string().min(1),
  kind: PortfolioSecurityKindSchema,
});

/**
 * A portfolio position: same epistemics/schema as a holdings.json row
 * (owner, band range, status, extraction, verification, mandatory official
 * filing source), with the security kind widened for non-universe tickers.
 */
export const PortfolioPositionSchema = HoldingSchema.extend({
  security: PortfolioSecurityRefSchema,
});

/** One directory row of data/portfolio/index.json. */
export const PortfolioIndexEntrySchema = z.object({
  memberId: z.string().regex(/^[A-Z]\d{6}$/),
  name: z.string().min(1),
  party: PartySchema,
  chamber: ChamberSchema,
  /** Two-letter state code. */
  state: z.string().length(2),
  active: z.boolean(),
  /** A member ships a portfolio file only with >= 1 merged trade. */
  tradeCount: z.number().int().positive(),
  /** Most recent transaction date across the member's merged trades. */
  lastTradeDate: IsoDateSchema,
  /** Membership in the config/traders.json ACTIVE roster (has a traders.json row). */
  rosterMember: z.boolean(),
});

/** data/portfolio/{memberId}.json - fetched lazily by the member detail view. */
export const PortfolioFileSchema = z.object({
  member: MemberSchema,
  /** All-ticker positions - unfiltered derivation, holdings.json epistemics. */
  positions: z.array(PortfolioPositionSchema),
  /** Full merged trade history, newest first. */
  trades: z.array(TradeSchema),
  /** Range-midpoint sparkline points, ascending by trade date. */
  series: z.array(SeriesPointSchema),
  /** Trader.measured shape for active-roster members; null otherwise. */
  measured: MeasuredPerformanceSchema.nullable(),
});

// ---------------------------------------------------------------------------
// v1.2 common holdings (data/common.json) - spec "v1.2 - common holdings view"
// ---------------------------------------------------------------------------

/** One member's stake in a commonly held security. */
export const CommonHoldingOwnerSchema = z.object({
  memberId: z.string().regex(/^[A-Z]\d{6}$/),
  name: z.string().min(1),
  party: PartySchema,
  chamber: ChamberSchema,
  /** Two-letter state code. */
  state: z.string().length(2),
  /** Still serving (roster corrections applied) - false renders a chip. */
  active: z.boolean(),
  /**
   * Transaction dates of the member's disclosed BUY trades in this security,
   * newest first, capped at 10. Empty when the position came from an annual
   * report only (no PTR buys in our coverage window).
   */
  buyDates: z.array(IsoDateSchema).max(10),
  /**
   * Aggregate disclosed range of the member's current positions in this
   * security (band lo/hi summed across owner attributions); for a fully
   * exited member, the aggregate range of the sold positions.
   */
  latestRange: ValueRangeSchema,
  /** holds/stale = counted in ownersCount; sold = exited (SOLD chip). */
  status: HoldingStatusSchema,
});

/**
 * One data/common.json row: a security currently held by >= 2 members,
 * aggregated across ALL member portfolios (all tickers - non-universe
 * securities carry kind "other"). Derived from the SAME positions/trades the
 * per-member portfolio files ship. Sorted ownersCount desc, then ticker.
 */
export const CommonHoldingSchema = z
  .object({
    /** Composite security key parts (ticker + kind). */
    security: PortfolioSecurityRefSchema,
    /** Resolved display name when known (universe securities). */
    name: z.string().min(1).optional(),
    /** Distinct members with a CURRENT (non-sold) position - the headline count. */
    ownersCount: z.number().int().min(2),
    /** Current owners by party; R + D + I always equals ownersCount. */
    partySplit: z.object({
      R: z.number().int().nonnegative(),
      D: z.number().int().nonnegative(),
      I: z.number().int().nonnegative(),
    }),
    /** Most recent disclosed buy date across all listed owners; null when the
     *  positions came from annual reports only. */
    latestBuyDate: IsoDateSchema.nullable(),
    /**
     * Every member with a derived position in this security - current owners
     * AND fully exited members (status "sold", excluded from ownersCount).
     */
    owners: z.array(CommonHoldingOwnerSchema).min(2),
  })
  .refine((c) => c.partySplit.R + c.partySplit.D + c.partySplit.I === c.ownersCount, {
    message: "partySplit must sum to ownersCount",
  })
  .refine((c) => c.owners.filter((o) => o.status !== "sold").length === c.ownersCount, {
    message: "ownersCount must equal the number of non-sold owners",
  });

// ---------------------------------------------------------------------------
// News strip (Exa-fed) and run metadata
// ---------------------------------------------------------------------------

export const NewsItemSchema = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  /** Publisher, e.g. "CoinDesk". */
  source: z.string().min(1),
  publishedAt: IsoDateSchema,
  summary: z.string().optional(),
  relatedMemberIds: z.array(z.string()).optional(),
  relatedTickers: z.array(z.string()).optional(),
});

export const MetaSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  /** As-of stamp per output file - rendered on every view. */
  asOf: z.object({
    bill: IsoDateSchema,
    members: IsoDateSchema,
    holdings: IsoDateSchema,
    trades: IsoDateSchema,
    traders: IsoDateSchema,
    news: IsoDateSchema,
  }),
  run: z.object({
    ok: z.boolean(),
    stats: z.record(z.string(), z.number()),
    errors: z.array(z.string()),
    /** Non-fatal problems from the run (skipped steps, per-row issues...). */
    warnings: z.array(z.string()).optional(),
  }),
});

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

/** config/universe.json - 36 securities, Tier 1/2 (research ticket 03). */
export const UniverseConfigSchema = z.object({
  universe: z.array(SecuritySchema),
});

/** One roster entry in config/traders.json. */
export const TraderConfigEntrySchema = z.object({
  /** Bioguide-style id. */
  id: z.string().regex(/^[A-Z]\d{6}$/),
  name: z.string().min(1),
  party: PartySchema,
  chamber: ChamberSchema,
  claims: z.array(ClaimSchema),
  note: z.string().optional(),
});

export const WatchEntrySchema = TraderConfigEntrySchema.extend({
  /** Why the member sits on the watch shelf instead of the active roster. */
  reason: z.string().min(1),
  status: z.enum(["departed", "stopped", "emerging"]),
});

/** config/traders.json - 15-active core roster + watch shelf (research ticket 10). */
export const TradersConfigSchema = z.object({
  active: z.array(TraderConfigEntrySchema),
  watch: z.array(WatchEntrySchema),
});

/** A contested-case pin the validation gate must enforce (research ticket 04). */
export const ContestedPinSchema = z.object({
  id: z.string().min(1),
  memberId: z.string().regex(/^[A-Z]\d{6}$/),
  memberName: z.string().min(1),
  rule: z.enum(["holds-security", "holding-range", "owner", "member-inactive"]),
  expect: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  forbid: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  note: z.string().min(1),
  source: z.string().optional(),
});

/** config/expectations.json - validation gate pins. */
export const ExpectationsSchema = z.object({
  holderBound: z
    .object({
      min: z.number().int().positive(),
      max: z.number().int().positive(),
    })
    .refine((b) => b.max >= b.min, { message: "max must be >= min" }),
  contested: z.array(ContestedPinSchema),
});
