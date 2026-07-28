import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Member, UniverseConfig } from "@clarity-btc/shared";
import { parseUniverseConfig } from "@clarity-btc/shared";
import {
  houseIndexUrl,
  ingestHouse,
  parseHouseIndexZip,
  ptrPdfUrl,
} from "../../src/house/index.js";
import type { HouseState } from "../../src/house/index.js";
import { saveHouseState } from "../../src/house/state.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "house");
const repoRoot = join(fixturesDir, "..", "..", "..", "..", "..");

const indexZip = new Uint8Array(readFileSync(join(fixturesDir, "2026FD.zip")));
const biggsPdf = new Uint8Array(readFileSync(join(fixturesDir, "20034195.pdf")));
// Note: the paper scan (8221321.pdf) is deliberately NOT served by the mock -
// paper DocIDs must be flagged from the index alone, without a PDF download.

const universe: UniverseConfig = parseUniverseConfig(
  JSON.parse(readFileSync(join(repoRoot, "config", "universe.json"), "utf8")),
);

const members: Member[] = [
  {
    bioguideId: "B001325",
    name: "Sheri Biggs",
    party: "R",
    chamber: "house",
    state: "SC",
    district: "SC-03",
    active: true,
  },
];

/** Serves the fixture index + fixture PDFs; 404s everything else. */
const fixtureFetch = ((input: RequestInfo | URL) => {
  const url = String(input);
  const body = (bytes: Uint8Array): Response =>
    new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 });
  if (url === houseIndexUrl(2026)) return Promise.resolve(body(indexZip));
  if (url === ptrPdfUrl(2026, "20034195")) return Promise.resolve(body(biggsPdf));
  return Promise.resolve(new Response("not found", { status: 404 }));
}) as typeof fetch;

/** Pre-seed state so only the fixture DocIDs (plus one 404) are "new". */
function seededState(keepNew: string[]): HouseState {
  const allPtrDocIds = parseHouseIndexZip(indexZip, 2026)
    .filter((f) => f.filingType === "P")
    .map((f) => f.docId);
  return {
    version: 1,
    years: {
      "2026": { seenDocIds: allPtrDocIds.filter((id) => !keepNew.includes(id)).sort() },
    },
  };
}

describe("ingestHouse (fixture-served end to end)", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "house-ingest-test-"));
    statePath = join(dir, "house.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("diffs, fetches, parses, flags scans, records failures, and resumes", async () => {
    // New this run: one e-filed text PTR (Biggs), one paper scan
    // (Fleischmann, not in the member roster), one PDF the server 404s.
    await saveHouseState(statePath, seededState(["20034195", "8221321", "20034201"]));

    const result = await ingestHouse({
      members,
      universe,
      year: 2026,
      statePath,
      fetchImpl: fixtureFetch,
    });

    expect(result.year).toBe(2026);
    expect(result.stats.indexFilings).toBe(1433);
    expect(result.stats.ptrFilings).toBe(318);
    expect(result.newDocIds.sort()).toEqual(["20034195", "20034201", "8221321"]);

    // The e-filed Biggs PTR parses into 8 schema-valid trades.
    expect(result.trades.length).toBe(8);
    for (const trade of result.trades) {
      expect(trade.memberId).toBe("B001325");
      expect(trade.owner).toBe("spouse");
      expect(trade.docUrl).toBe(
        "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034195.pdf",
      );
      expect(trade.filedDate).toBe("2026-03-21");
      expect(trade.security).toBeNull(); // no BTC-universe assets in this filing
    }
    const barclays = result.trades.find((t) => t.assetRaw.startsWith("BARCLAYS"));
    expect(barclays).toMatchObject({
      side: "sell",
      range: { lo: 100001, hi: 250000 },
      transactionDate: "2026-02-19",
      late: false,
    });

    // The paper scan is flagged for OCR, not parsed here.
    expect(result.ocrFlagged).toEqual([
      {
        docId: "8221321",
        docUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/8221321.pdf",
        memberId: null,
        filerName: 'Hon. Charles J. "Chuck" Fleischmann',
        stateDst: "TN03",
        filedDate: "2026-02-09",
        extraction: "pdf-ocr",
        ocrPending: true,
        note: "paper filing (image scan) - OCR runs in the Action, flagged here only",
      },
    ]);

    // The 404 is a typed per-document issue, left unseen for the next run.
    expect(result.issues).toEqual([
      expect.objectContaining({ docId: "20034201", code: "pdf-download" }),
    ]);

    const saved = JSON.parse(await readFile(statePath, "utf8")) as HouseState;
    const seen = new Set(saved.years["2026"]?.seenDocIds);
    expect(seen.has("20034195")).toBe(true);
    expect(seen.has("8221321")).toBe(true);
    expect(seen.has("20034201")).toBe(false);

    // Second run: only the failed DocID is retried; nothing re-emitted.
    const rerun = await ingestHouse({
      members,
      universe,
      year: 2026,
      statePath,
      fetchImpl: fixtureFetch,
    });
    expect(rerun.newDocIds).toEqual(["20034201"]);
    expect(rerun.trades).toEqual([]);
    expect(rerun.ocrFlagged).toEqual([]);
    expect(rerun.issues.length).toBe(1);
  });

  it("throws a typed error when the index cannot be downloaded", async () => {
    const offline = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    await expect(
      ingestHouse({ members, universe, year: 2026, fetchImpl: offline }),
    ).rejects.toMatchObject({ name: "HouseIngestError", code: "index-download" });
  });

  it("caps downloads with maxPdfsPerRun and leaves the rest unseen", async () => {
    await saveHouseState(statePath, seededState(["20034195", "8221321", "20034201"]));
    const result = await ingestHouse({
      members,
      universe,
      year: 2026,
      statePath,
      fetchImpl: fixtureFetch,
      maxPdfsPerRun: 1,
    });
    // Index order is alphabetical by filer: Alford's 404ing 20034201 is first,
    // fails, and stays unseen along with the two uncapped fixture DocIDs.
    expect(result.newDocIds).toEqual(["20034201"]);
    const saved = JSON.parse(await readFile(statePath, "utf8")) as HouseState;
    expect(saved.years["2026"]?.seenDocIds.length).toBe(318 - 3);
  });

  it("throws state-io on a corrupt state file instead of reprocessing", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(statePath, "{not json", "utf8");
    await expect(
      ingestHouse({ members, universe, year: 2026, statePath, fetchImpl: fixtureFetch }),
    ).rejects.toMatchObject({ code: "state-io" });
  });
});
