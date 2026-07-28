/**
 * Normalize raw kadoa trade rows into the shared `Trade` contract.
 *
 * Scope rules:
 * - congress rows only (kadoa also ships OGE executive-branch 278-T rows);
 * - phantom filers (congress rows whose filer has no party, e.g. the
 *   "Alan Armstrong" eFD artifact) are dropped;
 * - filers that don't resolve to our member roster are skipped and reported
 *   (`unmatchedFilers`) — the tracker only follows rostered members;
 * - rows that can't satisfy the Trade schema (missing amount range, dates,
 *   doc_url, or an unsupported transaction type like "Exchange") are skipped
 *   with a reason, never silently.
 *
 * Securities resolve through the universe config; unresolved assets keep
 * `security: null` (they still matter for the portfolio-tracker view).
 */
import {
  TradeSchema,
  type Member,
  type Security,
  type Trade,
} from "@clarity-btc/shared";
import { buildMemberMatcher } from "./members.js";
import { buildSecurityResolver } from "./resolve.js";
import type { KadoaFiler, KadoaTradeRow } from "./types.js";

export interface KadoaSkippedRow {
  /** kadoa row id, e.g. "house_20034736_g0". */
  id: string;
  reason: string;
}

export interface NormalizeKadoaResult {
  trades: Trade[];
  skipped: KadoaSkippedRow[];
  /** Congress filer names (with a party) we could not map onto the roster. */
  unmatchedFilers: string[];
}

export interface NormalizeKadoaOptions {
  /** Member roster (data/members.json) used to resolve filer names. */
  members: Member[];
  /** Security universe (config/universe.json). */
  universe: Security[];
  /** Filer directory (filers.json) — context for rows lacking embedded filer fields. */
  filers?: KadoaFiler[];
  /** Filer of a per-filer file (`filer/{id}.json` rows carry only filer_id). */
  defaultFiler?: KadoaFiler;
}

const OWNER_MAP: Record<string, Trade["owner"] & string> = {
  self: "self",
  sp: "spouse",
  spouse: "spouse",
  dc: "dependent",
  child: "dependent",
  dependent: "dependent",
  jt: "joint",
  joint: "joint",
};

function mapOwner(owner: string | null | undefined): Trade["owner"] | undefined {
  if (owner == null) return undefined;
  return OWNER_MAP[owner.trim().toLowerCase()];
}

function mapSide(transactionType: string | null | undefined): Trade["side"] | undefined {
  if (transactionType == null) return undefined;
  const t = transactionType.trim().toLowerCase();
  if (t === "purchase" || t.startsWith("purchase")) return "buy";
  if (t === "sale" || t.startsWith("sale")) return "sell";
  return undefined;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface FilerContext {
  name: string | undefined;
  branch: string | undefined;
  chamber: string | undefined;
  party: string | undefined;
}

function filerContext(
  row: KadoaTradeRow,
  filersById: Map<string, KadoaFiler>,
  defaultFiler: KadoaFiler | undefined,
): FilerContext {
  const fromDirectory =
    row.filer_id != null ? filersById.get(row.filer_id) : undefined;
  const fallback =
    fromDirectory ??
    (defaultFiler !== undefined &&
    (row.filer_id == null || row.filer_id === defaultFiler.id)
      ? defaultFiler
      : undefined);
  return {
    name: row.filer_name ?? fallback?.full_name ?? undefined,
    branch: row.branch ?? fallback?.branch ?? undefined,
    chamber: row.chamber ?? fallback?.chamber ?? undefined,
    party: row.party ?? fallback?.party ?? undefined,
  };
}

/** Is this row from an official congressional source? */
function isCongressRow(row: KadoaTradeRow, ctx: FilerContext): boolean {
  if (ctx.branch != null) return ctx.branch === "congress";
  if (row.source_id != null) {
    return row.source_id === "house_clerk" || row.source_id === "senate_efd";
  }
  return false;
}

export function normalizeKadoaTrades(
  rows: KadoaTradeRow[],
  options: NormalizeKadoaOptions,
): NormalizeKadoaResult {
  const matcher = buildMemberMatcher(options.members);
  const resolver = buildSecurityResolver(options.universe);
  const filersById = new Map<string, KadoaFiler>(
    (options.filers ?? []).map((f) => [f.id, f]),
  );
  if (options.defaultFiler !== undefined) {
    filersById.set(options.defaultFiler.id, options.defaultFiler);
  }

  const trades: Trade[] = [];
  const skipped: KadoaSkippedRow[] = [];
  const unmatchedFilers = new Set<string>();
  const seenIds = new Set<string>();

  for (const row of rows) {
    if (seenIds.has(row.id)) {
      skipped.push({ id: row.id, reason: "duplicate row id" });
      continue;
    }
    seenIds.add(row.id);

    const ctx = filerContext(row, filersById, options.defaultFiler);
    if (!isCongressRow(row, ctx)) {
      skipped.push({ id: row.id, reason: "non-congress filer" });
      continue;
    }
    if (ctx.party == null || ctx.party === "") {
      // Phantom filers (corporate officers mis-scraped into eFD results).
      skipped.push({
        id: row.id,
        reason: `phantom filer (no party): ${ctx.name ?? row.filer_id ?? "unknown"}`,
      });
      continue;
    }
    if (ctx.name === undefined) {
      skipped.push({ id: row.id, reason: "row has no filer name" });
      continue;
    }
    const member = matcher.match(ctx.name, ctx.chamber);
    if (member === undefined) {
      unmatchedFilers.add(ctx.name);
      skipped.push({ id: row.id, reason: `filer not in member roster: ${ctx.name}` });
      continue;
    }

    const side = mapSide(row.transaction_type);
    if (side === undefined) {
      skipped.push({
        id: row.id,
        reason: `unsupported transaction_type: ${row.transaction_type ?? "null"}`,
      });
      continue;
    }
    if (row.amount_range_low == null || row.amount_range_high == null) {
      skipped.push({ id: row.id, reason: "missing amount range" });
      continue;
    }
    if (row.transaction_date == null || !ISO_DATE.test(row.transaction_date)) {
      skipped.push({ id: row.id, reason: "missing/invalid transaction_date" });
      continue;
    }
    if (row.filing_date == null || !ISO_DATE.test(row.filing_date)) {
      skipped.push({ id: row.id, reason: "missing/invalid filing_date" });
      continue;
    }
    if (row.doc_url == null || !/^https?:\/\//.test(row.doc_url)) {
      skipped.push({ id: row.id, reason: "missing doc_url" });
      continue;
    }
    const assetRaw = row.asset_name?.trim() || row.ticker?.trim() || "";
    if (assetRaw === "") {
      skipped.push({ id: row.id, reason: "no asset text" });
      continue;
    }

    const lo = Math.min(row.amount_range_low, row.amount_range_high);
    const hi = Math.max(row.amount_range_low, row.amount_range_high);
    const owner = mapOwner(row.owner);
    const note = row.comment?.trim();

    const candidate: Trade = {
      memberId: member.bioguideId,
      assetRaw,
      security: resolver.resolve({
        ticker: row.ticker,
        assetName: row.asset_name,
        assetType: row.asset_type,
      }),
      side,
      ...(owner !== undefined ? { owner } : {}),
      range: { lo, hi },
      transactionDate: row.transaction_date,
      filedDate: row.filing_date,
      docUrl: row.doc_url,
      late: row.is_late === 1 || row.is_late === true,
      ...(note !== undefined && note !== "" ? { note } : {}),
    };
    const parsed = TradeSchema.safeParse(candidate);
    if (!parsed.success) {
      skipped.push({
        id: row.id,
        reason: `schema: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      });
      continue;
    }
    trades.push(parsed.data);
  }

  return { trades, skipped, unmatchedFilers: [...unmatchedFilers].sort() };
}
