/**
 * Daily pipeline orchestrator (build ticket 11) - wires the eight spec steps:
 *
 *   1. House Clerk ingest            packages/ingest/src/house
 *   2. Senate eFD ingest             packages/ingest/src/senate
 *   3. kadoa cross-check + merge     packages/ingest/src/kadoa
 *   4. Holdings derivation           packages/ingest/src/holdings
 *   5. Exa review + news strip       packages/ingest/src/review   (skippable)
 *   6. Bill refresh                  packages/ingest/src/bill     (null-tolerant)
 *   7. Returns computation           packages/ingest/src/returns
 *   8. Validation gate               packages/ingest/src/holdings/validate
 *
 * then writes the seven data/*.json outputs atomically (write temps, validate
 * every payload through the shared parsers, rename together). On a validation
 * gate failure or any fatal step error data/ is left untouched - the last
 * good data keeps serving - and a machine-readable failure report is written
 * to the state directory for the Action to upload / open an issue from.
 *
 * All network access is injectable through PipelineIO so tests and the CI
 * --dry-run mode run fixture-backed with zero network (see dryrun.ts).
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseBill,
  parseExpectations,
  parseHoldings,
  parseMembers,
  parseMeta,
  parseNews,
  parseTraders,
  parseTrades,
  parseTradersConfig,
  parseUniverseConfig,
  securityKey,
  type Bill,
  type Expectations,
  type Holding,
  type Member,
  type Meta,
  type NewsItem,
  type Trade,
  type Trader,
  type TradersConfig,
  type UniverseConfig,
} from "@clarity-btc/shared";
import { ingestHouse } from "./house/index.js";
import { ingestSenate } from "./senate/index.js";
import { crossCheckKadoa, type MergedTrade } from "./kadoa/index.js";
import type { KadoaFetchFn } from "./kadoa/fetch.js";
import { deriveHoldings, validateHoldings, type ValidationReport } from "./holdings/index.js";
import { reviewWithExa } from "./review/index.js";
import { refreshBillDetailed, type FetchText } from "./bill/index.js";
import { computeReturns } from "./returns/index.js";
import type { YahooFetchFn } from "./returns/yahoo.js";

// ---------------------------------------------------------------------------
// Options / result types
// ---------------------------------------------------------------------------

/**
 * Injectable IO surface. Every field defaults to the real network client;
 * tests and dry-run inject fixture-backed fakes (zero network).
 */
export interface PipelineIO {
  houseFetch?: typeof fetch;
  /** House Clerk index year. Default: current UTC year. */
  houseYear?: number;
  senateFetch?: typeof fetch;
  senateBaseUrl?: string;
  kadoaFetch?: KadoaFetchFn;
  kadoaBaseUrl?: string;
  exaFetch?: typeof fetch;
  /** Overrides process.env.EXA_API_KEY. */
  exaApiKey?: string;
  billFetchText?: FetchText;
  yahooFetch?: YahooFetchFn;
  yahooBaseUrl?: string;
  /** "Today" (ISO date) for as-of stamps and recency windows. Default: UTC today. */
  now?: string;
}

export interface RunPipelineOptions {
  /** Directory holding the seven output *.json files (the repo's data/). */
  dataDir: string;
  /** Disk-cache root for the kadoa/Yahoo fetch layers. */
  cacheDir: string;
  /** Resumable state + failure reports (committed by the Action, like data/). */
  stateDir: string;
  /** Config directory (universe.json, traders.json, expectations.json). */
  configDir?: string;
  /** Override just the expectations file (dry-run uses fixture expectations). */
  expectationsPath?: string;
  /**
   * Dry-run: identical wiring and writes, but the caller points dataDir at a
   * scratch copy and injects fixture IO. runPipeline itself only records the
   * flag in meta stats; the CLI owns the scratch setup.
   */
  dryRun?: boolean;
  /** Exa daily query budget; 0 skips the review step with a warning. */
  exaQueryBudget?: number;
  io?: PipelineIO;
  log?: (line: string) => void;
}

export interface PipelineFailure {
  /** Step identifier, e.g. "house-ingest", "validation-gate", "write-outputs". */
  step: string;
  message: string;
  /** Present when the validation gate failed. */
  validation?: ValidationReport;
}

export interface PipelineResult {
  ok: boolean;
  stats: Record<string, number>;
  warnings: string[];
  /** Absolute paths written (all seven on success, none on failure). */
  wroteFiles: string[];
  validation?: ValidationReport;
  failure?: PipelineFailure;
  /** Where the failure report was written (failures only). */
  failureReportPath?: string;
}

export const DATA_FILES = [
  "bill.json",
  "members.json",
  "holdings.json",
  "trades.json",
  "traders.json",
  "news.json",
  "meta.json",
] as const;

export const FAILURE_REPORT_FILE = "failure-report.json";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    return await readJson(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function holdingKey(h: Holding): string {
  return `${h.memberId}|${securityKey(h.security)}|${h.owner}`;
}

function tradeLedgerKey(t: Trade): string {
  return [
    t.memberId,
    t.docUrl,
    t.assetRaw,
    t.transactionDate,
    t.side,
    t.owner ?? "self",
    t.range.lo,
    t.range.hi,
  ].join("|");
}

/** Serialize with the repo's JSON house style (2-space indent, trailing \n). */
function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// State files (accumulated across runs; live in stateDir, not data/)
// ---------------------------------------------------------------------------

const OFFICIAL_LEDGER_FILE = "official-trades.json";
const ANNUAL_BASELINE_FILE = "annual-baseline.json";

/**
 * The House/Senate ingests are incremental (per-filing state) - each run only
 * yields NEW filings. The official-trade ledger and annual-holdings baseline
 * accumulate those rows across runs so every run can rebuild trades.json and
 * holdings.json from scratch. They are state, not output: they are written as
 * soon as the ingest steps finish, so a later gate failure never loses rows.
 */
async function appendLedger<T>(
  filePath: string,
  parse: (v: unknown) => T[],
  existingKey: (row: T) => string,
  newRows: T[],
): Promise<T[]> {
  const raw = await readJsonIfExists(filePath);
  const rows = raw === undefined ? [] : parse(raw);
  const seen = new Set(rows.map(existingKey));
  for (const row of newRows) {
    const key = existingKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  await writeFile(filePath, toJson(rows), "utf8");
  return rows;
}

// ---------------------------------------------------------------------------
// Verification carry-forward (derive resets to "unverified" every run)
// ---------------------------------------------------------------------------

interface CarryForwardResult {
  holdings: Holding[];
  /** New or materially changed rows - the Exa review candidates. */
  changed: Holding[];
}

/**
 * deriveHoldings stamps every row "unverified"; prior runs may have upgraded
 * rows to "corroborated"/"conflict" via Exa. For rows whose range and status
 * are unchanged since the previous output, adopt the previous verification
 * and keep previously attached news sources. Rows that are new or changed
 * stay "unverified" and go to the review step.
 */
export function carryForwardVerification(
  previous: Holding[],
  derived: Holding[],
): CarryForwardResult {
  const prevByKey = new Map(previous.map((h) => [holdingKey(h), h]));
  const holdings: Holding[] = [];
  const changed: Holding[] = [];
  for (const row of derived) {
    const prev = prevByKey.get(holdingKey(row));
    const unchanged =
      prev !== undefined &&
      prev.range.lo === row.range.lo &&
      prev.range.hi === row.range.hi &&
      prev.status === row.status;
    if (!unchanged) {
      holdings.push(row);
      changed.push(row);
      continue;
    }
    const extraSources = prev.sources.filter(
      (s) => s.kind === "news" && !row.sources.some((r) => r.url === s.url),
    );
    holdings.push({
      ...row,
      verification: prev.verification,
      sources: [...row.sources, ...extraSources],
    });
  }
  return { holdings, changed };
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

interface OutputFile {
  name: (typeof DATA_FILES)[number];
  /** Payload to serialize (may carry extra fields, e.g. trade provenance). */
  payload: unknown;
  /** Shared-contract parser the serialized payload must round-trip through. */
  validate: (v: unknown) => unknown;
}

/**
 * Write temp files for every output, validate each serialized payload through
 * its shared parser, then rename all temps into place. A failure before the
 * rename phase removes the temps and leaves data/ untouched.
 */
async function writeOutputsAtomically(dataDir: string, files: OutputFile[]): Promise<string[]> {
  await mkdir(dataDir, { recursive: true });
  const temps: Array<{ tmp: string; final: string }> = [];
  try {
    for (const file of files) {
      const body = toJson(file.payload);
      // Round-trip validation: what lands on disk must satisfy the contract.
      file.validate(JSON.parse(body));
      const tmp = path.join(dataDir, `.${file.name}.tmp`);
      await writeFile(tmp, body, "utf8");
      temps.push({ tmp, final: path.join(dataDir, file.name) });
    }
  } catch (err) {
    await Promise.allSettled(temps.map(({ tmp }) => rm(tmp, { force: true })));
    throw err;
  }
  for (const { tmp, final } of temps) {
    await rename(tmp, final);
  }
  return temps.map(({ final }) => final);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

class StepError extends Error {
  constructor(
    readonly step: string,
    cause: unknown,
  ) {
    super(`[${step}] ${message(cause)}`);
    this.name = "StepError";
  }
}

async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StepError) throw err;
    throw new StepError(name, err);
  }
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
  const io = options.io ?? {};
  const log = options.log ?? (() => undefined);
  const now = io.now ?? todayUtc();
  const configDir = options.configDir ?? "config";
  const stats: Record<string, number> = {};
  const warnings: string[] = [];
  const failureReportPath = path.join(options.stateDir, FAILURE_REPORT_FILE);

  const fail = async (failure: PipelineFailure): Promise<PipelineResult> => {
    log(`FAILED at ${failure.step}: ${failure.message}`);
    await mkdir(options.stateDir, { recursive: true });
    await writeFile(
      failureReportPath,
      toJson({
        generatedAt: new Date().toISOString(),
        ok: false,
        step: failure.step,
        reason: failure.message,
        ...(failure.validation !== undefined
          ? { validationFailures: failure.validation.failures, validation: failure.validation }
          : {}),
        stats,
        warnings,
      }),
      "utf8",
    );
    return {
      ok: false,
      stats,
      warnings,
      wroteFiles: [],
      failure,
      failureReportPath,
      ...(failure.validation !== undefined ? { validation: failure.validation } : {}),
    };
  };

  try {
    await mkdir(options.stateDir, { recursive: true });

    // -- Inputs: config + previous (last good) outputs ----------------------
    const { universe, tradersConfig, expectations, members, previous } = await step(
      "load-inputs",
      async () => {
        const universe: UniverseConfig = parseUniverseConfig(
          await readJson(path.join(configDir, "universe.json")),
        );
        const tradersConfig: TradersConfig = parseTradersConfig(
          await readJson(path.join(configDir, "traders.json")),
        );
        const expectations: Expectations = parseExpectations(
          await readJson(options.expectationsPath ?? path.join(configDir, "expectations.json")),
        );
        const members: Member[] = parseMembers(
          await readJson(path.join(options.dataDir, "members.json")),
        );
        const prevRaw = {
          bill: await readJsonIfExists(path.join(options.dataDir, "bill.json")),
          holdings: await readJsonIfExists(path.join(options.dataDir, "holdings.json")),
          news: await readJsonIfExists(path.join(options.dataDir, "news.json")),
          meta: await readJsonIfExists(path.join(options.dataDir, "meta.json")),
        };
        const previous = {
          bill: prevRaw.bill === undefined ? undefined : parseBill(prevRaw.bill),
          holdings: prevRaw.holdings === undefined ? [] : parseHoldings(prevRaw.holdings),
          news: prevRaw.news === undefined ? [] : parseNews(prevRaw.news),
          meta: prevRaw.meta === undefined ? undefined : parseMeta(prevRaw.meta),
        };
        return { universe, tradersConfig, expectations, members, previous };
      },
    );

    // -- Step 1: House Clerk ingest ----------------------------------------
    const house = await step("house-ingest", () =>
      ingestHouse({
        members,
        universe,
        statePath: path.join(options.stateDir, "house-state.json"),
        ...(io.houseYear !== undefined ? { year: io.houseYear } : {}),
        ...(io.houseFetch !== undefined ? { fetchImpl: io.houseFetch } : {}),
      }),
    );
    stats["houseNewPtrs"] = house.stats.newPtrs;
    stats["houseTrades"] = house.trades.length;
    stats["houseOcrFlagged"] = house.ocrFlagged.length;
    stats["houseUnmatchedFilings"] = house.unmatched.length;
    stats["houseIssues"] = house.issues.length;
    for (const issue of house.issues) {
      warnings.push(`house ${issue.docId} [${issue.code}]: ${issue.message}`);
    }
    log(`house: ${house.trades.length} trades from ${house.stats.newPtrs} new PTRs`);

    // -- Step 2: Senate eFD ingest ------------------------------------------
    const senate = await step("senate-ingest", () =>
      ingestSenate({
        universe: universe.universe,
        members,
        statePath: path.join(options.stateDir, "senate-state.json"),
        ...(io.senateFetch !== undefined ? { fetchImpl: io.senateFetch } : {}),
        ...(io.senateBaseUrl !== undefined ? { baseUrl: io.senateBaseUrl } : {}),
      }),
    );
    stats["senateNewFilings"] = senate.newFilingIds.length;
    stats["senateTrades"] = senate.trades.length;
    stats["senateAnnualHoldings"] = senate.holdings.length;
    stats["senatePaperStubs"] = senate.paperStubs.length;
    stats["senateSkipped"] = senate.skipped.length;
    log(
      `senate: ${senate.trades.length} trades, ${senate.holdings.length} annual holdings from ${senate.newFilingIds.length} new filings`,
    );

    // -- Accumulate incremental output into the state ledgers ---------------
    const { officialTrades, annualBaseline } = await step("state-ledgers", async () => {
      const officialTrades = await appendLedger(
        path.join(options.stateDir, OFFICIAL_LEDGER_FILE),
        parseTrades,
        tradeLedgerKey,
        [...house.trades, ...senate.trades],
      );
      const annualBaseline = await appendLedger(
        path.join(options.stateDir, ANNUAL_BASELINE_FILE),
        parseHoldings,
        (h) => `${holdingKey(h)}|${h.asOf}|${h.sources[0]?.url ?? ""}`,
        senate.holdings,
      );
      return { officialTrades, annualBaseline };
    });
    stats["officialTradeLedger"] = officialTrades.length;
    stats["annualBaselineRows"] = annualBaseline.length;

    // -- Step 3: kadoa cross-check + merge ----------------------------------
    const kadoa = await step("kadoa-crosscheck", () =>
      crossCheckKadoa(officialTrades, {
        members,
        universe: universe.universe,
        fetch: {
          cacheDir: path.join(options.cacheDir, "kadoa"),
          ...(io.kadoaFetch !== undefined ? { fetchFn: io.kadoaFetch } : {}),
          ...(io.kadoaBaseUrl !== undefined ? { baseUrl: io.kadoaBaseUrl } : {}),
        },
      }),
    );
    const merged: MergedTrade[] = kadoa.merged;
    stats["kadoaNormalized"] = kadoa.normalized;
    stats["kadoaSkippedRows"] = kadoa.skipped.length;
    stats["kadoaUnmatchedFilers"] = kadoa.unmatchedFilers.length;
    stats["tradesMerged"] = merged.length;
    stats["tradesProvenanceOfficial"] = merged.filter((t) => t.provenance === "official").length;
    stats["tradesProvenanceBoth"] = merged.filter((t) => t.provenance === "both").length;
    stats["tradesProvenanceKadoa"] = merged.filter((t) => t.provenance === "kadoa").length;
    stats["tradesBackfilled"] = kadoa.backfilled.length;
    stats["tradesMissedByOfficial"] = kadoa.missedByOfficial.length;
    stats["tradeConflicts"] = kadoa.conflicts.length;
    if (kadoa.missedByOfficial.length > 0) {
      warnings.push(
        `kadoa cross-check: ${kadoa.missedByOfficial.length} row(s) inside the official coverage window were only found via kadoa - investigate the official ingest`,
      );
    }
    log(`kadoa: merged ${merged.length} trades (${kadoa.conflicts.length} conflicts)`);

    // -- Step 4: holdings derivation ----------------------------------------
    const derived = await step("holdings-derivation", () =>
      deriveHoldings({ baseline: annualBaseline, trades: merged, universe, now }),
    );
    stats["holdingsDerived"] = derived.holdings.length;
    stats["holdingRejects"] = derived.rejects.length;
    for (const reject of derived.rejects) {
      warnings.push(
        `holdings reject ${reject.memberId} ${
          reject.security === null ? "?" : securityKey(reject.security)
        }: ${reject.reason}`,
      );
    }
    const carried = carryForwardVerification(previous.holdings, derived.holdings);
    let holdings = carried.holdings;
    stats["holdingsChanged"] = carried.changed.length;
    log(`holdings: ${holdings.length} rows (${carried.changed.length} new/changed)`);

    // -- Step 5: Exa review + news strip (skippable, never fatal) -----------
    const exaApiKey = io.exaApiKey ?? process.env["EXA_API_KEY"];
    const exaBudget = options.exaQueryBudget;
    let news: NewsItem[] = previous.news;
    let newsRefreshed = false;
    if (exaApiKey === undefined || exaApiKey === "") {
      warnings.push(
        "Exa review skipped: EXA_API_KEY is not set - holdings stay unverified and the news strip keeps its previous items",
      );
    } else if (exaBudget !== undefined && exaBudget <= 0) {
      warnings.push(
        "Exa review skipped: query budget is 0 - holdings stay unverified and the news strip keeps its previous items",
      );
    } else {
      try {
        const review = await reviewWithExa({
          holdings: carried.changed,
          members,
          universe,
          apiKey: exaApiKey,
          now,
          ...(exaBudget !== undefined ? { queryBudget: exaBudget } : {}),
          ...(io.exaFetch !== undefined ? { fetchImpl: io.exaFetch } : {}),
          log,
        });
        const reviewedByKey = new Map(review.reviewed.map((h) => [holdingKey(h), h]));
        holdings = holdings.map((h) => reviewedByKey.get(holdingKey(h)) ?? h);
        news = review.news;
        newsRefreshed = true;
        stats["exaQueriesUsed"] = review.queriesUsed;
        stats["exaQueriesSkipped"] = review.queriesSkipped;
        stats["exaSkippedHoldings"] = review.skippedHoldings;
        warnings.push(...review.issues.map((i) => `exa: ${i}`));
        log(`exa: ${review.queriesUsed} queries, ${review.news.length} news items`);
      } catch (err) {
        warnings.push(
          `Exa review failed (${message(err)}) - holdings stay unverified and the news strip keeps its previous items`,
        );
      }
    }
    stats["newsItems"] = news.length;

    // -- Step 6: bill refresh (null-tolerant: keep last-good bill.json) -----
    let bill: Bill;
    try {
      const refreshed = await refreshBillDetailed({
        asOf: now,
        ...(io.billFetchText !== undefined ? { fetchText: io.billFetchText } : {}),
      });
      bill = refreshed.bill;
      warnings.push(...refreshed.warnings.map((w) => `bill: ${w}`));
      stats["billRefreshed"] = 1;
      log(`bill: refreshed, latest action ${bill.latestAction.date}`);
    } catch (err) {
      if (previous.bill === undefined) {
        throw new StepError(
          "bill-refresh",
          `refresh failed and there is no last-good bill.json to keep: ${message(err)}`,
        );
      }
      bill = previous.bill;
      stats["billRefreshed"] = 0;
      warnings.push(
        `bill refresh failed (${message(err)}) - keeping last-good bill.json as of ${bill.asOf}`,
      );
    }
    stats["billVotes"] = bill.votes.length;

    // -- Step 7: returns computation ----------------------------------------
    const returns = await step("returns", () =>
      computeReturns(tradersConfig, merged, {
        members,
        asOf: now,
        kadoa: {
          cacheDir: path.join(options.cacheDir, "kadoa"),
          ...(io.kadoaFetch !== undefined ? { fetchFn: io.kadoaFetch } : {}),
          ...(io.kadoaBaseUrl !== undefined ? { baseUrl: io.kadoaBaseUrl } : {}),
        },
        yahoo: {
          cacheDir: path.join(options.cacheDir, "yahoo"),
          ...(io.yahooFetch !== undefined ? { fetchFn: io.yahooFetch } : {}),
          ...(io.yahooBaseUrl !== undefined ? { baseUrl: io.yahooBaseUrl } : {}),
        },
      }),
    );
    const traders: Trader[] = returns.traders;
    stats["tradersRanked"] = traders.length;
    stats["tradersMeasured"] = traders.filter((t) => t.measured !== null).length;
    stats["tradersClaimsNotSupported"] = traders.filter((t) => t.claimsSupported === false).length;
    stats["unpriceableBuys"] = returns.computations.reduce((n, c) => n + c.unpriceable.length, 0);
    warnings.push(...returns.warnings.map((w) => `returns: ${w}`));
    log(`returns: measured ${stats["tradersMeasured"]}/${traders.length} roster members`);

    // -- Step 8: validation gate --------------------------------------------
    const validation = await step("validation-gate", () =>
      validateHoldings({ holdings, expectations, universe, members }),
    );
    stats["tier1Holders"] = validation.tier1HolderCount;
    stats["validationFailures"] = validation.failures.length;
    if (!validation.ok) {
      return await fail({
        step: "validation-gate",
        message: `validation gate failed with ${validation.failures.length} failure(s): ${validation.failures
          .map((f) => f.message)
          .join(" | ")}`,
        validation,
      });
    }

    // -- Write the seven outputs atomically ---------------------------------
    stats["dryRun"] = options.dryRun === true ? 1 : 0;
    const meta: Meta = {
      generatedAt: new Date().toISOString(),
      asOf: {
        bill: bill.asOf,
        members: now,
        holdings: now,
        trades: now,
        traders: now,
        news: newsRefreshed ? now : (previous.meta?.asOf.news ?? now),
      },
      run: { ok: true, stats, errors: [], warnings },
    };
    const wroteFiles = await step("write-outputs", () =>
      writeOutputsAtomically(options.dataDir, [
        { name: "bill.json", payload: bill, validate: parseBill },
        { name: "members.json", payload: members, validate: parseMembers },
        { name: "holdings.json", payload: holdings, validate: parseHoldings },
        // Merged rows keep their provenance stamp; the shared parser tolerates
        // (and strips) unknown keys, so the contract still holds on read.
        { name: "trades.json", payload: merged, validate: parseTrades },
        { name: "traders.json", payload: traders, validate: parseTraders },
        { name: "news.json", payload: news, validate: parseNews },
        { name: "meta.json", payload: meta, validate: parseMeta },
      ]),
    );

    // A successful run supersedes any stale failure report.
    await rm(failureReportPath, { force: true });
    log(`wrote ${wroteFiles.length} files to ${options.dataDir}`);
    return { ok: true, stats, warnings, wroteFiles, validation };
  } catch (err) {
    const stepName = err instanceof StepError ? err.step : "pipeline";
    return await fail({ step: stepName, message: message(err) });
  }
}
