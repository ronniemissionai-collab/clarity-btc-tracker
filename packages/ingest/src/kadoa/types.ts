/**
 * Raw row shapes published by kadoa-org/congress-trading-monitor (MIT) at
 * https://raw.githubusercontent.com/kadoa-org/congress-trading-monitor/main/public/data/
 *
 * Two row flavors exist (verified live 2026-07-28):
 * - top-level `trades.json`: rows embed filer context (`filer_name`, `branch`,
 *   `chamber`, `party`, ...) but the file is capped to the ~5000 most recent rows;
 * - per-filer `filer/{filer_id}.json`: `{ filer, trades }` where trade rows carry
 *   only `filer_id` — filer context comes from the sibling `filer` object (these
 *   files hold the full history, needed for backfill).
 *
 * Schemas below validate only the fields we consume and pass everything else
 * through untouched.
 */
import { z } from "zod";

/** One transaction row (either flavor). */
export const KadoaTradeRowSchema = z
  .object({
    id: z.string(),
    /** "house_clerk" | "senate_efd" | "oge_executive" */
    source_id: z.string().nullish(),
    transaction_date: z.string().nullish(),
    filing_date: z.string().nullish(),
    /** "Self" | "SP" | "Spouse" | "DC" | "Child" | "JT" | "Joint" | null */
    owner: z.string().nullish(),
    ticker: z.string().nullish(),
    asset_name: z.string().nullish(),
    /** e.g. "ST", "Stock", "CT" (crypto), "ET", "GS", ... */
    asset_type: z.string().nullish(),
    /** "Purchase" | "Sale (Full)" | "Sale (Partial)" | "Exchange" */
    transaction_type: z.string().nullish(),
    amount_range_low: z.number().nullish(),
    amount_range_high: z.number().nullish(),
    /** 0/1 in the published data; tolerate booleans. */
    is_late: z.union([z.number(), z.boolean()]).nullish(),
    comment: z.string().nullish(),
    /** Links back to the official Clerk PDF / eFD filing page. */
    doc_url: z.string().nullish(),
    filer_id: z.string().nullish(),
    // Filer context — present on top-level rows, absent on per-filer rows.
    filer_name: z.string().nullish(),
    /** "congress" | "executive" */
    branch: z.string().nullish(),
    chamber: z.string().nullish(),
    party: z.string().nullish(),
    state: z.string().nullish(),
  })
  .passthrough();

export type KadoaTradeRow = z.infer<typeof KadoaTradeRowSchema>;

/** One entry of `filers.json`, and the `filer` object of per-filer files. */
export const KadoaFilerSchema = z
  .object({
    id: z.string(),
    full_name: z.string(),
    /** "congress" | "executive" */
    branch: z.string().nullish(),
    chamber: z.string().nullish(),
    /** null for executive filers and for phantom filers (e.g. "Alan Armstrong"). */
    party: z.string().nullish(),
    state: z.string().nullish(),
  })
  .passthrough();

export type KadoaFiler = z.infer<typeof KadoaFilerSchema>;

/** Per-filer file: `public/data/filer/{filer_id}.json`. */
export const KadoaFilerFileSchema = z.object({
  filer: KadoaFilerSchema,
  trades: z.array(KadoaTradeRowSchema),
});

export type KadoaFilerFile = z.infer<typeof KadoaFilerFileSchema>;

/** One entry of `tickers.json`. */
export const KadoaTickerSchema = z
  .object({
    ticker: z.string(),
    trade_count: z.number().nullish(),
    filer_count: z.number().nullish(),
    purchases: z.number().nullish(),
    sales: z.number().nullish(),
    est_volume: z.number().nullish(),
  })
  .passthrough();

export type KadoaTicker = z.infer<typeof KadoaTickerSchema>;

/** One entry of `returns.json` (per-filer measured returns). */
export const KadoaReturnSchema = z
  .object({
    id: z.string(),
    full_name: z.string().nullish(),
    scored_buys: z.number().nullish(),
    avg_excess: z.number().nullish(),
    avg_ret: z.number().nullish(),
    weighted_excess: z.number().nullish(),
  })
  .passthrough();

export type KadoaReturn = z.infer<typeof KadoaReturnSchema>;

/** `prices.json`: ticker -> {latest, previous, month} close snapshots. */
export const KadoaPricePointSchema = z.object({
  date: z.string(),
  close: z.number(),
});

export const KadoaPricesSchema = z.record(
  z.string(),
  z
    .object({
      latest: KadoaPricePointSchema.nullish(),
      previous: KadoaPricePointSchema.nullish(),
      month: KadoaPricePointSchema.nullish(),
    })
    .passthrough(),
);

export type KadoaPrices = z.infer<typeof KadoaPricesSchema>;
