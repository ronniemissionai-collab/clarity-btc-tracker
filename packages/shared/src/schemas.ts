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

export const TraderSchema = z.object({
  memberId: z.string().regex(/^[A-Z]\d{6}$/),
  tradeCount: z.number().int().nonnegative(),
  claims: z.array(ClaimSchema),
  /** Null until the returns step has priced the member's disclosed buys. */
  measured: MeasuredPerformanceSchema.nullable(),
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
