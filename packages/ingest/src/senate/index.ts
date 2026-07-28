/**
 * Pipeline step 2: Senate eFD ingest.
 *
 * CSRF/agreement handshake -> incremental DataTables search (PTRs + annual
 * reports since the last run) -> parse electronic filing HTML into Trade[]
 * and Holding[] per the shared contract; paper filings (scanned GIFs, ~7%)
 * become OCR-flagged stubs carrying the scan URLs for manual/OCR follow-up.
 *
 * Endpoints and page structures verified live (research ticket 09 + fixture
 * capture 2026-07-28).
 */
import type { Holding, Member, Security, Trade } from "@clarity-btc/shared";
import { parseHolding, parseTrade } from "@clarity-btc/shared";
import { EFD_REPORT_TYPE, EfdClient } from "./client.js";
import { SenateIngestError } from "./errors.js";
import { parseAnnualAssets, parsePaperHtml, parsePtrHtml } from "./parse.js";
import type { SenateFilingRef } from "./search.js";
import { parseSearchRows } from "./search.js";
import { buildMemberResolver, buildSecurityResolver } from "./resolve.js";
import type { SenateIngestState } from "./state.js";
import {
  advanceSenateState,
  initialSenateState,
  loadSenateState,
  saveSenateState,
} from "./state.js";

export {
  EFD_BASE_URL,
  EFD_REPORT_TYPE,
  EfdClient,
  toEfdDate,
  type EfdClientOptions,
  type EfdSearchQuery,
  type EfdSearchResponse,
} from "./client.js";
export {
  SenateFilingError,
  SenateHandshakeError,
  SenateIngestError,
  SenateParseError,
  SenateSearchError,
  SenateStateError,
  type SenateErrorKind,
} from "./errors.js";
export {
  parseAmountRange,
  parseAnnualAssets,
  parseOwner,
  parsePaperHtml,
  parsePtrHtml,
  textOf,
  type AmountRange,
  type SenateAnnualAsset,
  type SenateOwner,
  type SenatePaperFiling,
  type SenatePtrFiling,
  type SenatePtrTransaction,
} from "./parse.js";
export {
  parseSearchRow,
  parseSearchRows,
  usDateToIso,
  type SenateFilingChannel,
  type SenateFilingKind,
  type SenateFilingRef,
} from "./search.js";
export {
  buildMemberResolver,
  buildSecurityResolver,
  type MemberResolver,
  type SecurityResolver,
} from "./resolve.js";
export {
  advanceSenateState,
  initialSenateState,
  loadSenateState,
  saveSenateState,
  type SenateIngestState,
} from "./state.js";

// ---------------------------------------------------------------------------
// Options / result types
// ---------------------------------------------------------------------------

export interface SenateIngestOptions {
  /** Security universe (config/universe.json) for asset resolution. */
  universe: Security[];
  /** Member roster for filer-name -> bioguideId resolution. */
  members: Member[];
  /** Path of the resumable state JSON; loaded before and saved after the run. */
  statePath?: string;
  /** In-memory state (overrides statePath loading; statePath still saved). */
  state?: SenateIngestState;
  /** First-run search window start (ISO date). Default: January 1 this year. */
  since?: string;
  /** Injectable fetch — tests serve fixtures through this; no network. */
  fetchImpl?: typeof fetch;
  /** eFD report types to search. Default: PTRs [11] + annual reports [7]. */
  reportTypes?: number[];
  /** eFD base URL override (tests). */
  baseUrl?: string;
}

/**
 * OCR-flagged stub for a paper filing: the transaction content lives in
 * scanned GIFs on the public CDN and needs OCR or manual review downstream.
 */
export interface SenatePaperStub {
  ocr: true;
  filingId: string;
  kind: SenateFilingRef["kind"];
  filerFirst: string;
  filerLast: string;
  /** Resolved member, or null when the filer is not on the roster. */
  memberId: string | null;
  reportTitle: string;
  filedDate: string;
  /** Official filing page (behind the eFD agreement wall). */
  url: string;
  /** Scan images (efd-media-public.senate.gov, fetchable without cookies). */
  imageUrls: string[];
}

/** A filing or row that was seen but intentionally not ingested. */
export interface SenateSkip {
  filingId: string;
  reason: string;
}

export interface SenateIngestResult {
  /** Filing uuids newly processed this run (electronic + paper). */
  newFilingIds: string[];
  /** All transactions from new electronic PTRs (full trades, any ticker). */
  trades: Trade[];
  /** Universe-matched holdings from new electronic annual reports. */
  holdings: Holding[];
  /** OCR-flagged stubs for new paper filings. */
  paperStubs: SenatePaperStub[];
  /** Filings/rows skipped with reasons (unresolved filers, parse failures…). */
  skipped: SenateSkip[];
  /** State after this run (also written to statePath when provided). */
  state: SenateIngestState;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const STOCK_ACT_WINDOW_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

function isLate(transactionDate: string, filedDate: string): boolean {
  const elapsed = Date.parse(filedDate) - Date.parse(transactionDate);
  return elapsed > STOCK_ACT_WINDOW_DAYS * DAY_MS;
}

export async function ingestSenate(
  options: SenateIngestOptions,
): Promise<SenateIngestResult> {
  const state =
    options.state ??
    (options.statePath !== undefined
      ? await loadSenateState(options.statePath)
      : initialSenateState());

  const since =
    state.lastSubmittedDate ??
    options.since ??
    `${new Date().getUTCFullYear()}-01-01`;

  const client = new EfdClient({
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
  });
  await client.handshake();

  const reportTypes = options.reportTypes ?? [
    EFD_REPORT_TYPE.ptr,
    EFD_REPORT_TYPE.annual,
  ];
  const rows: string[][] = [];
  for (const reportType of reportTypes) {
    rows.push(
      ...(await client.searchAll({
        reportTypes: [reportType],
        submittedStartDate: since,
      })),
    );
  }

  const seen = new Set(state.processedFilingIds);
  const refs = parseSearchRows(rows, options.baseUrl).filter(
    (ref) => !seen.has(ref.filingId),
  );

  const securities = buildSecurityResolver(options.universe);
  const resolveMember = buildMemberResolver(options.members);

  const trades: Trade[] = [];
  const holdings: Holding[] = [];
  const paperStubs: SenatePaperStub[] = [];
  const skipped: SenateSkip[] = [];
  const processed: { filingId: string; filedDate: string }[] = [];

  for (const ref of refs) {
    try {
      if (ref.channel === "paper") {
        const paper = parsePaperHtml(await client.fetchFilingHtml(ref.url));
        paperStubs.push({
          ocr: true,
          filingId: ref.filingId,
          kind: ref.kind,
          filerFirst: ref.filerFirst,
          filerLast: ref.filerLast,
          memberId: resolveMember(ref.filerFirst, ref.filerLast)?.bioguideId ?? null,
          reportTitle: ref.reportTitle,
          filedDate: ref.filedDate,
          url: ref.url,
          imageUrls: paper.imageUrls,
        });
        processed.push({ filingId: ref.filingId, filedDate: ref.filedDate });
        continue;
      }

      if (ref.kind === "other") {
        skipped.push({
          filingId: ref.filingId,
          reason: `unsupported report type: "${ref.reportTitle}"`,
        });
        processed.push({ filingId: ref.filingId, filedDate: ref.filedDate });
        continue;
      }

      const member = resolveMember(ref.filerFirst, ref.filerLast);
      if (member === null) {
        skipped.push({
          filingId: ref.filingId,
          reason: `filer "${ref.filerFirst} ${ref.filerLast}" not on the member roster`,
        });
        processed.push({ filingId: ref.filingId, filedDate: ref.filedDate });
        continue;
      }

      const html = await client.fetchFilingHtml(ref.url);
      if (ref.kind === "ptr") {
        const filing = parsePtrHtml(html);
        const filedDate = filing.filedDate ?? ref.filedDate;
        for (const tx of filing.transactions) {
          const side = tx.transactionType.startsWith("Purchase")
            ? "buy"
            : tx.transactionType.startsWith("Sale")
              ? "sell"
              : null;
          if (side === null) {
            skipped.push({
              filingId: ref.filingId,
              reason: `row ${tx.rowIndex}: transaction type "${tx.transactionType}" is neither buy nor sell`,
            });
            continue;
          }
          // Carry the eFD Sale (Full) / Sale (Partial) distinction into the
          // note - the holdings derivation reads "partial sale" from it.
          const notes: string[] = [];
          if (tx.transactionType.startsWith("Sale (Partial)")) notes.push("partial sale");
          else if (tx.transactionType.startsWith("Sale (Full)")) notes.push("full sale");
          if (tx.comment !== undefined) notes.push(tx.comment);
          trades.push(
            parseTrade({
              memberId: member.bioguideId,
              assetRaw: tx.assetName,
              security: securities.resolve(tx.ticker, tx.assetName),
              side,
              ...(tx.owner !== null ? { owner: tx.owner } : {}),
              range: tx.amount,
              transactionDate: tx.transactionDate,
              filedDate,
              docUrl: ref.url,
              late: isLate(tx.transactionDate, filedDate),
              ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
            }),
          );
        }
      } else {
        for (const asset of parseAnnualAssets(html)) {
          const security = securities.resolve(asset.ticker, asset.assetName);
          if (security === null) continue; // holdings view is universe-only
          if (asset.owner === null) {
            skipped.push({
              filingId: ref.filingId,
              reason: `asset row ${asset.rowIndex}: unrecognized owner "${asset.ownerRaw}"`,
            });
            continue;
          }
          if (asset.value === null) {
            skipped.push({
              filingId: ref.filingId,
              reason: `asset row ${asset.rowIndex}: no value band reported for "${asset.assetName}"`,
            });
            continue;
          }
          holdings.push(
            parseHolding({
              memberId: member.bioguideId,
              security,
              owner: asset.owner,
              range: asset.value,
              status: "holds",
              asOf: ref.filedDate,
              extraction: "efd-html",
              verification: "unverified",
              sources: [{ kind: "filing", url: ref.url, title: ref.reportTitle }],
              note: `from ${ref.reportTitle}: ${asset.assetName}`,
            }),
          );
        }
      }
      processed.push({ filingId: ref.filingId, filedDate: ref.filedDate });
    } catch (error) {
      if (error instanceof SenateIngestError && error.kind === "parse") {
        // One malformed filing must not sink the run; leave it unprocessed so
        // a fixed parser can pick it up on a later run.
        skipped.push({
          filingId: ref.filingId,
          reason: `parse failed: ${error.message}`,
        });
        continue;
      }
      throw error;
    }
  }

  const nextState = advanceSenateState(state, processed);
  if (options.statePath !== undefined) {
    await saveSenateState(options.statePath, nextState);
  }

  return {
    newFilingIds: processed.map((p) => p.filingId),
    trades,
    holdings,
    paperStubs,
    skipped,
    state: nextState,
  };
}
