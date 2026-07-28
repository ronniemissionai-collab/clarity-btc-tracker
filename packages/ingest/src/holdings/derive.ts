/**
 * Pipeline step 4: derive "currently holds" rows.
 *
 * Baseline = annual-report holdings (the Senate module emits these on the
 * shared Holding contract; House annual parsing may be thin or absent -
 * both inputs are optional and validated at intake). Chronological merged
 * PTR trades (the kadoa merge output, provenance-stamped) then mutate the
 * baseline per the data-model Answer (research ticket 05):
 *
 *   - buys create or extend positions (ranges aggregate per member +
 *     security + owner by summing lo and hi separately);
 *   - a full sale marks the position "sold" as of the transaction date;
 *   - a partial sale recomputes the range conservatively
 *     (lo' = max(0, lo - sale.hi), hi' = hi - sale.lo);
 *   - PTRs dated on/before the annual's as-of date are already reflected in
 *     the annual and are skipped (no double counting);
 *   - owner attribution (self/spouse/dependent/joint/trust) is preserved -
 *     each owner is a distinct position/row.
 *
 * Every output Holding carries asOf, extraction, verification "unverified"
 * (the Exa review step upgrades later), and a mandatory official filing
 * source URL - a row that would ship without one goes to `rejects` instead.
 */
import type {
  Holding,
  Security,
  SecurityRef,
  Trade,
  UniverseConfig,
} from "@clarity-btc/shared";
import { HoldingSchema, securityKey } from "@clarity-btc/shared";
import { buildUniverseIndex } from "./universe.js";

type Owner = Holding["owner"];
type Extraction = Holding["extraction"];
type SourceRef = Holding["sources"][number];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A row that could not be shipped, with the reason it was dropped. */
export interface HoldingReject {
  memberId: string;
  security: SecurityRef | null;
  owner: Owner | null;
  reason: string;
}

export interface DeriveHoldingsOptions {
  /**
   * Annual-report holdings baseline (Senate emits these; House annual
   * parsing may be thin - missing/partial baselines are handled gracefully).
   */
  baseline?: Holding[];
  /**
   * Chronological merged PTR trades (kadoa merge output; MergedTrade extends
   * Trade, so provenance-stamped rows pass through unchanged). Sorted
   * internally - input order does not matter.
   */
  trades?: Trade[];
  /** config/universe.json - the holdings view is universe-only. */
  universe: UniverseConfig | Security[];
  /** "Today" for stale marking (ISO date). Default: current UTC date. */
  now?: string;
  /**
   * A "holds" row not confirmed by any filing within this many days of `now`
   * is downgraded to "stale". Default: 365.
   */
  staleAfterDays?: number;
}

export interface DeriveHoldingsResult {
  holdings: Holding[];
  rejects: HoldingReject[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const EXTRACTION_RANK: Record<Extraction, number> = {
  "efd-html": 0,
  "pdf-text": 1,
  "pdf-ocr": 2,
};

/** Keep the least-reliable extraction so uncertainty stays visible. */
function worstExtraction(a: Extraction, b: Extraction): Extraction {
  return EXTRACTION_RANK[b] > EXTRACTION_RANK[a] ? b : a;
}

/** Trades carry no extraction field; infer it from the filing channel. */
function tradeExtraction(trade: Trade): Extraction {
  return trade.docUrl.includes("efdsearch.senate.gov") ? "efd-html" : "pdf-text";
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}

/** House PTR partial sales carry a "partial sale" note; detect via note text. */
function isPartialSale(trade: Trade): boolean {
  return /partial/i.test(trade.note ?? "");
}

interface Position {
  memberId: string;
  security: SecurityRef;
  owner: Owner;
  lo: number;
  hi: number;
  status: "holds" | "sold";
  asOf: string;
  extraction: Extraction;
  sources: SourceRef[];
  notes: string[];
  /** Annual baseline as-of date; PTRs on/before it are already reflected. */
  baselineAsOf: string | null;
}

function positionKey(memberId: string, ref: SecurityRef, owner: Owner): string {
  return `${memberId}|${securityKey(ref)}|${owner}`;
}

function addSource(position: Position, source: SourceRef): void {
  if (!position.sources.some((s) => s.url === source.url)) {
    position.sources.push(source);
  }
}

function addNote(position: Position, note: string): void {
  if (!position.notes.includes(note)) position.notes.push(note);
}

/** Chronological order: transaction date, buys before same-day sells, filed date. */
function compareTrades(a: Trade, b: Trade): number {
  if (a.transactionDate !== b.transactionDate) {
    return a.transactionDate < b.transactionDate ? -1 : 1;
  }
  if (a.side !== b.side) return a.side === "buy" ? -1 : 1;
  if (a.filedDate !== b.filedDate) return a.filedDate < b.filedDate ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Baseline intake
// ---------------------------------------------------------------------------

function intakeBaseline(
  baseline: Holding[],
  universe: ReturnType<typeof buildUniverseIndex>,
  positions: Map<string, Position>,
  rejects: HoldingReject[],
): void {
  // Validate + universe-filter, then group by member+security+owner.
  const grouped = new Map<string, Holding[]>();
  for (const row of baseline) {
    const parsed = HoldingSchema.safeParse(row);
    if (!parsed.success) {
      const partial = row as Partial<Holding>;
      rejects.push({
        memberId: partial.memberId ?? "unknown",
        security: partial.security ?? null,
        owner: partial.owner ?? null,
        reason: `baseline row failed the Holding contract: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
      continue;
    }
    const holding = parsed.data;
    if (!universe.has(holding.security)) continue; // holdings view is universe-only
    const key = positionKey(holding.memberId, holding.security, holding.owner);
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [holding]);
    else list.push(holding);
  }

  for (const [key, rows] of grouped) {
    // Baseline = the LATEST annual disclosure; earlier annuals are superseded.
    const latestAsOf = rows.map((r) => r.asOf).sort().at(-1) ?? "";
    const latest = rows.filter((r) => r.asOf === latestAsOf);
    const first = latest[0]!;

    // Multiple same-day rows for one member+security+owner (e.g. two
    // accounts on one annual) aggregate by summing lo and hi separately.
    const position: Position = {
      memberId: first.memberId,
      security: first.security,
      owner: first.owner,
      lo: 0,
      hi: 0,
      status: latest.every((r) => r.status === "sold") ? "sold" : "holds",
      asOf: latestAsOf,
      extraction: first.extraction,
      sources: [],
      notes: [],
      baselineAsOf: latestAsOf,
    };
    for (const row of latest) {
      position.lo += row.range.lo;
      position.hi += row.range.hi;
      position.extraction = worstExtraction(position.extraction, row.extraction);
      for (const source of row.sources) addSource(position, source);
      if (row.note !== undefined) addNote(position, row.note);
    }
    positions.set(key, position);
  }
}

// ---------------------------------------------------------------------------
// Trade application
// ---------------------------------------------------------------------------

function applyTrade(
  trade: Trade,
  positions: Map<string, Position>,
  rejects: HoldingReject[],
): void {
  const ref = trade.security;
  if (ref === null) return; // unresolved asset - cannot be a universe holding
  const owner: Owner = trade.owner ?? "self";
  const key = positionKey(trade.memberId, ref, owner);
  const position = positions.get(key);

  // PTRs on/before the annual's as-of date are already inside the baseline.
  if (
    position !== undefined &&
    position.baselineAsOf !== null &&
    trade.transactionDate <= position.baselineAsOf
  ) {
    return;
  }

  const source: SourceRef = { kind: "filing", url: trade.docUrl };
  const extraction = tradeExtraction(trade);

  if (trade.side === "buy") {
    if (position === undefined || position.status === "sold") {
      // Create (or re-open after a full exit) a position from this buy.
      positions.set(key, {
        memberId: trade.memberId,
        security: ref,
        owner,
        lo: trade.range.lo,
        hi: trade.range.hi,
        status: "holds",
        asOf: trade.transactionDate,
        extraction,
        sources: [source],
        notes: [],
        baselineAsOf: position?.baselineAsOf ?? null,
      });
      return;
    }
    position.lo += trade.range.lo;
    position.hi += trade.range.hi;
    position.asOf = maxIso(position.asOf, trade.transactionDate);
    position.extraction = worstExtraction(position.extraction, extraction);
    addSource(position, source);
    return;
  }

  // Sell.
  const partial = isPartialSale(trade);
  if (position === undefined || position.status === "sold") {
    if (partial) {
      // A partial sale proves a position we never saw a baseline for; the
      // remaining amount is unknowable - surface for investigation.
      rejects.push({
        memberId: trade.memberId,
        security: ref,
        owner,
        reason: `partial sale on ${trade.transactionDate} without a known position - remaining holdings unknown (missed annual baseline?)`,
      });
      return;
    }
    // PTR-only full sale (e.g. exit with no annual in our window): record the
    // exit itself so the member renders with a SOLD chip, not as a holder.
    positions.set(key, {
      memberId: trade.memberId,
      security: ref,
      owner,
      lo: trade.range.lo,
      hi: trade.range.hi,
      status: "sold",
      asOf: trade.transactionDate,
      extraction,
      sources: [source],
      notes: ["sale reported by PTR with no annual baseline in our coverage"],
      baselineAsOf: position?.baselineAsOf ?? null,
    });
    return;
  }

  position.asOf = maxIso(position.asOf, trade.transactionDate);
  position.extraction = worstExtraction(position.extraction, extraction);
  addSource(position, source);

  if (!partial) {
    position.status = "sold"; // range keeps the size of the exited position
    return;
  }

  // Partial sale: recompute the range conservatively.
  const lo = Math.max(0, position.lo - trade.range.hi);
  const hi = position.hi - trade.range.lo;
  if (hi <= 0) {
    position.status = "sold";
    addNote(position, `partial sales through ${trade.transactionDate} exhausted the disclosed range`);
    return;
  }
  position.lo = Math.min(lo, hi);
  position.hi = hi;
  addNote(position, `partial sale ${trade.transactionDate}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function deriveHoldings(options: DeriveHoldingsOptions): DeriveHoldingsResult {
  const universe = buildUniverseIndex(options.universe);
  const now = options.now ?? new Date().toISOString().slice(0, 10);
  const staleAfterDays = options.staleAfterDays ?? 365;

  const positions = new Map<string, Position>();
  const rejects: HoldingReject[] = [];

  intakeBaseline(options.baseline ?? [], universe, positions, rejects);

  const trades = (options.trades ?? [])
    .filter((t) => t.security !== null && universe.has(t.security))
    .sort(compareTrades);
  for (const trade of trades) applyTrade(trade, positions, rejects);

  const holdings: Holding[] = [];
  for (const position of positions.values()) {
    if (!position.sources.some((s) => s.kind === "filing")) {
      rejects.push({
        memberId: position.memberId,
        security: position.security,
        owner: position.owner,
        reason: "no official filing source URL - a row without one does not ship",
      });
      continue;
    }
    const status =
      position.status === "holds" && daysBetween(position.asOf, now) > staleAfterDays
        ? "stale"
        : position.status;
    const candidate = {
      memberId: position.memberId,
      security: position.security,
      owner: position.owner,
      range: { lo: position.lo, hi: position.hi },
      status,
      asOf: position.asOf,
      extraction: position.extraction,
      verification: "unverified", // the Exa review step upgrades later
      sources: position.sources,
      ...(position.notes.length > 0 ? { note: position.notes.join("; ") } : {}),
    };
    const parsed = HoldingSchema.safeParse(candidate);
    if (!parsed.success) {
      rejects.push({
        memberId: position.memberId,
        security: position.security,
        owner: position.owner,
        reason: `derived row failed the Holding contract: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
      continue;
    }
    holdings.push(parsed.data);
  }

  holdings.sort((a, b) => {
    if (a.memberId !== b.memberId) return a.memberId < b.memberId ? -1 : 1;
    const ak = securityKey(a.security);
    const bk = securityKey(b.security);
    if (ak !== bk) return ak < bk ? -1 : 1;
    return a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0;
  });

  return { holdings, rejects };
}
