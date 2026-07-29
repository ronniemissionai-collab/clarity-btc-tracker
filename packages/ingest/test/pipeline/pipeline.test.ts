/**
 * Pipeline e2e over fixtures (build ticket 11): the dry-run wiring the CI
 * workflow runs, exercised directly. Zero network - every step gets the
 * fixture-backed IO from src/dryrun.ts.
 *
 * Covers: all eight steps execute; the seven core outputs round-trip through
 * the shared parsers; v1.1 portfolio emission (index + per-member files,
 * slimmed trades.json, precomputed trader series); atomic-write semantics
 * (no temp litter); a validation-gate failure leaves data/ untouched and
 * writes a machine-readable failure report; a bill-source outage keeps the
 * last-good bill.json.
 */
import { cp, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseBill,
  parseHoldings,
  parseMembers,
  parseMeta,
  parseNews,
  parsePortfolioFile,
  parsePortfolioIndex,
  parseTraders,
  parseTrades,
} from "@clarity-btc/shared";
import { runPipeline, DATA_FILES, FAILURE_REPORT_FILE, PORTFOLIO_DIR } from "../../src/pipeline.js";
import type { PipelineIO, RunPipelineOptions } from "../../src/pipeline.js";
import { createDryRunIO, DRY_RUN_EXPECTATIONS_PATH, seedDryRunState } from "../../src/dryrun.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

interface Workspace {
  dataDir: string;
  cacheDir: string;
  stateDir: string;
  options: RunPipelineOptions;
  io: PipelineIO;
}

/** Scratch workspace seeded exactly like `npm run pipeline -- --dry-run`. */
async function makeWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(path.join(tmpdir(), "pipeline-e2e-"));
  const dataDir = path.join(root, "data");
  const cacheDir = path.join(root, "cache");
  const stateDir = path.join(root, "state");
  await cp(path.join(repoRoot, "data"), dataDir, { recursive: true });
  await seedDryRunState(stateDir);
  const io = await createDryRunIO();
  return {
    dataDir,
    cacheDir,
    stateDir,
    io,
    options: {
      dataDir,
      cacheDir,
      stateDir,
      configDir: path.join(repoRoot, "config"),
      expectationsPath: DRY_RUN_EXPECTATIONS_PATH,
      dryRun: true,
      io,
    },
  };
}

async function snapshotDataDir(dataDir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const name of await readdir(dataDir)) {
    snapshot.set(name, await readFile(path.join(dataDir, name), "utf8"));
  }
  return snapshot;
}

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(file, "utf8")) as unknown;

describe("runPipeline dry-run e2e (fixtures, zero network)", () => {
  it("executes all steps and atomically writes the contract-valid outputs", async () => {
    const ws = await makeWorkspace();
    const result = await runPipeline(ws.options);

    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
    // Seven core files + portfolio/index.json + one file per indexed member.
    expect(result.stats["portfolioFiles"]).toBeGreaterThan(0);
    expect(result.wroteFiles).toHaveLength(7 + 1 + result.stats["portfolioFiles"]!);

    // Every step left its fingerprint in the stats.
    expect(result.stats["houseTrades"]).toBe(8); // Biggs e-filed PTR
    expect(result.stats["houseOcrFlagged"]).toBe(1); // Fleischmann paper scan
    expect(result.stats["senateTrades"]).toBe(13); // Moreno 2 + Tuberville 11
    expect(result.stats["senatePaperStubs"]).toBe(2);
    expect(result.stats["kadoaNormalized"]).toBeGreaterThan(0);
    expect(result.stats["tradesMerged"]).toBeGreaterThan(0);
    expect(result.stats["holdingsDerived"]).toBeGreaterThan(0);
    expect(result.stats["exaQueriesUsed"]).toBeGreaterThan(0); // review ran (fixture key)
    expect(result.stats["billRefreshed"]).toBe(1);
    expect(result.stats["tradersRanked"]).toBe(15); // full active roster
    expect(result.stats["tier1Holders"]).toBeGreaterThanOrEqual(1); // gate ran
    expect(result.validation?.ok).toBe(true);

    // Provenance counts are complete: official + both + kadoa = merged.
    expect(
      result.stats["tradesProvenanceOfficial"]! +
        result.stats["tradesProvenanceBoth"]! +
        result.stats["tradesProvenanceKadoa"]!,
    ).toBe(result.stats["tradesMerged"]);

    // Atomic semantics: the seven files + the portfolio dir, no temp litter.
    const names = (await readdir(ws.dataDir)).sort();
    expect(names).toEqual([...DATA_FILES, PORTFOLIO_DIR].sort());

    // Schema round-trip of every emitted file through the shared parsers.
    const bill = parseBill(await readJson(path.join(ws.dataDir, "bill.json")));
    const members = parseMembers(await readJson(path.join(ws.dataDir, "members.json")));
    const holdings = parseHoldings(await readJson(path.join(ws.dataDir, "holdings.json")));
    const trades = parseTrades(await readJson(path.join(ws.dataDir, "trades.json")));
    const traders = parseTraders(await readJson(path.join(ws.dataDir, "traders.json")));
    parseNews(await readJson(path.join(ws.dataDir, "news.json")));
    const meta = parseMeta(await readJson(path.join(ws.dataDir, "meta.json")));

    // Integration fields promoted in this ticket are wired through.
    expect(bill.requiresHouseRepassage).toBe(false); // no Senate passage in fixtures
    expect(members.length).toBeGreaterThan(0);
    expect(traders).toHaveLength(15);

    // v1.1: trades.json is SLIM - universe-resolved rows only.
    expect(trades.length).toBe(result.stats["slimmedTrades"]);
    expect(trades.length).toBeLessThan(result.stats["tradesMerged"]!);
    expect(trades.every((t) => t.security !== null)).toBe(true);

    // v1.1: every traders.json row carries its precomputed sparkline series.
    expect(traders.every((t) => Array.isArray(t.series))).toBe(true);
    const richest = traders.find((t) => (t.series?.length ?? 0) > 0);
    expect(richest).toBeDefined();
    for (const point of richest!.series!) {
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(point.value).toBeGreaterThan(0);
    }

    // v1.1: the portfolio directory mirrors index.json exactly (pipeline
    // invariant: index count == files written), and every file + the index
    // round-trip through the shared parsers.
    const portfolioDir = path.join(ws.dataDir, PORTFOLIO_DIR);
    const portfolioIndex = parsePortfolioIndex(
      await readJson(path.join(portfolioDir, "index.json")),
    );
    expect(portfolioIndex).toHaveLength(result.stats["portfolioFiles"]!);
    const onDisk = (await readdir(portfolioDir)).sort();
    expect(onDisk).toEqual(
      ["index.json", ...portfolioIndex.map((e) => `${e.memberId}.json`)].sort(),
    );
    let positionsSeen = 0;
    for (const entry of portfolioIndex) {
      expect(entry.tradeCount).toBeGreaterThanOrEqual(1);
      const file = parsePortfolioFile(
        await readJson(path.join(portfolioDir, `${entry.memberId}.json`)),
      );
      expect(file.member.bioguideId).toBe(entry.memberId);
      expect(file.trades).toHaveLength(entry.tradeCount);
      expect(file.series).toHaveLength(entry.tradeCount);
      // Full history, newest first; index carries the latest transaction date.
      for (let i = 1; i < file.trades.length; i++) {
        expect(file.trades[i - 1]!.transactionDate >= file.trades[i]!.transactionDate).toBe(true);
      }
      expect(file.trades[0]!.transactionDate).toBe(entry.lastTradeDate);
      // Positions keep holdings.json epistemics: official filing mandatory.
      for (const position of file.positions) {
        expect(position.sources.some((s) => s.kind === "filing")).toBe(true);
      }
      positionsSeen += file.positions.length;
    }
    expect(positionsSeen).toBe(result.stats["portfolioPositions"]);
    // Roster members are flagged in the directory and carry measured returns.
    const rosterRows = portfolioIndex.filter((e) => e.rosterMember);
    expect(rosterRows.length).toBeGreaterThan(0);
    const measuredTrader = traders.find((t) => t.measured !== null);
    expect(measuredTrader).toBeDefined();
    const measuredFile = parsePortfolioFile(
      await readJson(path.join(portfolioDir, `${measuredTrader!.memberId}.json`)),
    );
    expect(measuredFile.measured).toEqual(measuredTrader!.measured);

    // Raw rows keep their provenance stamp (the parser tolerates + strips it).
    const rawTrades = (await readJson(path.join(ws.dataDir, "trades.json"))) as Array<
      Record<string, unknown>
    >;
    expect(rawTrades.every((t) => ["official", "kadoa", "both"].includes(String(t["provenance"])))).toBe(
      true,
    );

    // Holdings ship with mandatory filing sources; meta carries the run log.
    expect(holdings.every((h) => h.sources.some((s) => s.kind === "filing"))).toBe(true);
    expect(meta.run.ok).toBe(true);
    expect(meta.run.stats["tier1Holders"]).toBe(result.stats["tier1Holders"]);
    expect(meta.run.warnings).toBeDefined();
    expect(meta.asOf.news).toBe("2026-07-28"); // strip refreshed via fixture Exa

    // A successful run leaves no failure report behind.
    await expect(readFile(path.join(ws.stateDir, FAILURE_REPORT_FILE))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("gate failure: data/ is untouched and a machine-readable report is written", async () => {
    const ws = await makeWorkspace();
    // Impossible holder bound -> the gate must fail after all steps ran.
    const strictPath = path.join(ws.stateDir, "strict-expectations.json");
    await writeFile(
      strictPath,
      JSON.stringify({ holderBound: { min: 999, max: 1000 }, contested: [] }),
      "utf8",
    );
    const before = await snapshotDataDir(ws.dataDir);

    const result = await runPipeline({ ...ws.options, expectationsPath: strictPath });

    expect(result.ok).toBe(false);
    expect(result.failure?.step).toBe("validation-gate");
    expect(result.wroteFiles).toEqual([]);
    expect(result.validation?.ok).toBe(false);
    expect(result.validation?.failures.some((f) => f.code === "holder-count")).toBe(true);

    // Last good data stands: every byte identical, no temp files.
    const after = await snapshotDataDir(ws.dataDir);
    expect(after).toEqual(before);

    // The failure report is machine-readable and names the failing step.
    const report = (await readJson(path.join(ws.stateDir, FAILURE_REPORT_FILE))) as {
      ok: boolean;
      step: string;
      reason: string;
      validationFailures: Array<{ code: string }>;
      stats: Record<string, number>;
      warnings: string[];
    };
    expect(report.ok).toBe(false);
    expect(report.step).toBe("validation-gate");
    expect(report.validationFailures[0]?.code).toBe("holder-count");
    expect(report.stats["houseTrades"]).toBe(8); // steps before the gate ran
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  it("bill outage: keeps the last-good bill.json and still succeeds", async () => {
    const ws = await makeWorkspace();
    const previousBill = await readFile(path.join(ws.dataDir, "bill.json"), "utf8");
    const io: PipelineIO = {
      ...ws.io,
      billFetchText: () => Promise.reject(new Error("govinfo is down")),
    };

    const result = await runPipeline({ ...ws.options, io });

    expect(result.ok).toBe(true);
    expect(result.stats["billRefreshed"]).toBe(0);
    expect(result.warnings.some((w) => w.includes("keeping last-good bill.json"))).toBe(true);
    const writtenBill = await readFile(path.join(ws.dataDir, "bill.json"), "utf8");
    expect(parseBill(JSON.parse(writtenBill))).toEqual(parseBill(JSON.parse(previousBill)));
  });

  it("skips the Exa review with a warning when no API key is available", async () => {
    const ws = await makeWorkspace();
    const io: PipelineIO = { ...ws.io };
    delete io.exaApiKey;
    delete io.exaFetch;
    const previousNews = await readFile(path.join(ws.dataDir, "news.json"), "utf8");
    const previousEnv = process.env["EXA_API_KEY"];
    delete process.env["EXA_API_KEY"];
    try {
      const result = await runPipeline({ ...ws.options, io });
      expect(result.ok).toBe(true);
      expect(result.stats["exaQueriesUsed"]).toBeUndefined();
      expect(result.warnings.some((w) => w.includes("Exa review skipped"))).toBe(true);
      // The news strip keeps its previous items instead of going empty.
      const news = await readFile(path.join(ws.dataDir, "news.json"), "utf8");
      expect(JSON.parse(news)).toEqual(JSON.parse(previousNews));
    } finally {
      if (previousEnv !== undefined) process.env["EXA_API_KEY"] = previousEnv;
    }
  });
});
