/**
 * Senate eFD ingest tests.
 *
 * All fixtures under test/fixtures/senate/ are real eFD responses captured
 * live through EfdClient on 2026-07-28 (one DataTables search page, two
 * electronic PTRs, one paper PTR, one electronic annual report). No test
 * touches the network: the integration tests inject a fixture-backed fetch.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Member, Security } from "@clarity-btc/shared";
import { isHolding, isTrade, parseUniverseConfig } from "@clarity-btc/shared";
import {
  advanceSenateState,
  buildMemberResolver,
  buildSecurityResolver,
  ingestSenate,
  initialSenateState,
  loadSenateState,
  parseAmountRange,
  parseAnnualAssets,
  parsePaperHtml,
  parsePtrHtml,
  parseSearchRows,
  saveSenateState,
  SenateParseError,
  SenateStateError,
  toEfdDate,
  usDateToIso,
} from "../src/senate/index.js";

const FIXTURES = new URL("./fixtures/senate/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURES), "utf8");
}

const MORENO_PTR_ID = "bccf83ce-dd72-4ab6-8564-b3bbb1d2ee55";
const TUBERVILLE_PTR_ID = "392ac3e5-07f6-4f8c-840f-84e9066ffb29";
const BLUMENTHAL_PAPER_ID = "3a4c5095-028a-4614-a692-836719da4e63";
const TILLIS_ANNUAL_ID = "cb89b62d-ebfa-4739-abb0-3ce34f5533b3";

/** Roster fixture: real bioguide ids, senate chamber (test data only). */
const MEMBERS: Member[] = [
  { bioguideId: "M001239", name: "Bernie Moreno", party: "R", chamber: "senate", state: "OH", active: true },
  { bioguideId: "T000278", name: "Tommy Tuberville", party: "R", chamber: "senate", state: "AL", active: true },
  { bioguideId: "B001277", name: "Richard Blumenthal", party: "D", chamber: "senate", state: "CT", active: true },
  { bioguideId: "T000476", name: "Thom Tillis", party: "R", chamber: "senate", state: "NC", active: true },
  { bioguideId: "G000602", name: "Brandon Gill", party: "R", chamber: "house", state: "TX", district: "TX-26", active: true },
];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

describe("date and amount primitives", () => {
  it("converts US dates to ISO", () => {
    expect(usDateToIso("07/24/2026")).toBe("2026-07-24");
    expect(usDateToIso("1/5/2026")).toBe("2026-01-05");
    expect(() => usDateToIso("2026-07-24")).toThrow(SenateParseError);
  });

  it("formats the eFD submitted_start_date filter", () => {
    expect(toEfdDate("2026-06-01")).toBe("06/01/2026 00:00:00");
  });

  it("parses eFD value bands", () => {
    expect(parseAmountRange("$1,001 - $15,000")).toEqual({ lo: 1001, hi: 15000 });
    expect(parseAmountRange("$500,001 - $1,000,000")).toEqual({ lo: 500001, hi: 1000000 });
    expect(parseAmountRange("Over $50,000,000")).toEqual({ lo: 50000000, hi: 50000000 });
    expect(parseAmountRange("None (or less than $1,001)")).toEqual({ lo: 0, hi: 1001 });
    expect(() => parseAmountRange("a bunch of money")).toThrow(SenateParseError);
  });
});

// ---------------------------------------------------------------------------
// Search rows
// ---------------------------------------------------------------------------

describe("search-response parsing", () => {
  it("parses the captured DataTables page into filing refs", async () => {
    const page = JSON.parse(await fixture("search-ptr-page.json")) as {
      recordsTotal: number;
      data: string[][];
    };
    expect(page.recordsTotal).toBe(23);

    const refs = parseSearchRows(page.data);
    expect(refs).toHaveLength(23);
    expect(refs.filter((r) => r.channel === "paper")).toHaveLength(2);
    expect(refs.filter((r) => r.channel === "electronic")).toHaveLength(21);
    expect(refs.every((r) => r.kind === "ptr")).toBe(true);

    const moreno = refs[0]!;
    expect(moreno).toMatchObject({
      filingId: MORENO_PTR_ID,
      channel: "electronic",
      kind: "ptr",
      filerFirst: "Bernie",
      filerLast: "Moreno",
      filedDate: "2026-07-24",
      reportTitle: "Periodic Transaction Report for 07/24/2026",
      url: `https://efdsearch.senate.gov/search/view/ptr/${MORENO_PTR_ID}/`,
    });

    // Paper filings render ALL-CAPS names with stray whitespace.
    const blumenthal = refs.find((r) => r.filingId === BLUMENTHAL_PAPER_ID)!;
    expect(blumenthal.channel).toBe("paper");
    expect(blumenthal.kind).toBe("ptr"); // derived from the report title
    expect(blumenthal.filerLast).toBe("BLUMENTHAL");

    // "Moran,  " -> trailing comma/space cleaned.
    const moran = refs.find((r) => r.filerFirst === "Jerry")!;
    expect(moran.filerLast).toBe("Moran");
  });
});

// ---------------------------------------------------------------------------
// Filing pages
// ---------------------------------------------------------------------------

describe("electronic PTR parsing", () => {
  it("parses a PTR with non-ticker ('--') asset rows", async () => {
    const filing = parsePtrHtml(await fixture("ptr-electronic.html"));
    expect(filing.filedDate).toBe("2026-07-24");
    expect(filing.transactions).toHaveLength(2);

    const [first, second] = filing.transactions;
    expect(first).toMatchObject({
      rowIndex: 1,
      transactionDate: "2026-06-22",
      owner: "self",
      ticker: null,
      assetName:
        "Canadian Imperial Bank of Commerce Trigger Autocallable Contingent Yield Notes",
      assetType: "Other",
      transactionType: "Sale (Full)",
      amount: { lo: 1001, hi: 15000 },
    });
    expect(second).toMatchObject({
      rowIndex: 2,
      transactionDate: "2026-06-24",
      ticker: null,
      assetName: "BofA Finance LLC Trigger Autocallable Contingent Yield Notes",
    });
    expect(second!.comment).toContain("iShares Russell 2000 Value ETF");
  });

  it("parses a PTR with ticker-linked rows", async () => {
    const filing = parsePtrHtml(await fixture("ptr-electronic-tickers.html"));
    expect(filing.filedDate).toBe("2026-07-16");
    expect(filing.transactions).toHaveLength(11);

    const first = filing.transactions[0]!;
    expect(first).toMatchObject({
      rowIndex: 1,
      transactionDate: "2026-06-08",
      owner: "joint",
      ticker: "TSCO",
      transactionType: "Sale (Full)",
      amount: { lo: 1001, hi: 15000 },
    });
    const last = filing.transactions[10]!;
    expect(last).toMatchObject({
      rowIndex: 11,
      owner: "self",
      ticker: "WAB",
      amount: { lo: 1001, hi: 15000 },
    });
    // HTML entities decoded in asset names.
    expect(
      filing.transactions.some((t) => t.assetName.includes("Procter & Gamble")),
    ).toBe(true);
  });

  it("throws a typed parse error when the transactions table is missing", () => {
    expect(() => parsePtrHtml("<html><body>maintenance</body></html>")).toThrow(
      SenateParseError,
    );
  });
});

describe("paper filing parsing", () => {
  it("extracts the scan GIF URLs in page order", async () => {
    const paper = parsePaperHtml(await fixture("paper-ptr.html"));
    expect(paper.imageUrls).toHaveLength(5);
    expect(paper.imageUrls[0]).toBe(
      "https://efd-media-public.senate.gov/media/2026/2/000/000/000000145.gif",
    );
    expect(
      paper.imageUrls.every((u) =>
        u.startsWith("https://efd-media-public.senate.gov/"),
      ),
    ).toBe(true);
  });

  it("throws a typed parse error when no scans are present", () => {
    expect(() => parsePaperHtml("<html></html>")).toThrow(SenateParseError);
  });
});

describe("annual report parsing (Part 3 assets)", () => {
  it("parses the captured annual report's asset table", async () => {
    const assets = parseAnnualAssets(await fixture("annual-electronic.html"));
    expect(assets).toHaveLength(34);

    const ibm = assets.find((a) => a.ticker === "IBM")!;
    expect(ibm).toMatchObject({
      assetName: "International Business Machines Corporation Common",
      owner: "self",
      value: { lo: 100001, hi: 250000 },
    });
    expect(ibm.assetType).toContain("Corporate Securities");

    // Non-ticker rows keep the name but drop the "Description: …" tail.
    const residence = assets.find((a) => a.assetName === "Washington Residence")!;
    expect(residence.ticker).toBeNull();
    expect(residence.owner).toBe("joint");
    expect(residence.value).toEqual({ lo: 500001, hi: 1000000 });
  });

  it("throws a typed parse error without a Part 3 section", () => {
    expect(() => parseAnnualAssets("<html></html>")).toThrow(SenateParseError);
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("security resolution against config/universe.json", () => {
  const loadUniverse = async (): Promise<Security[]> => {
    const raw = await readFile(
      new URL("../../../config/universe.json", import.meta.url),
      "utf8",
    );
    return parseUniverseConfig(JSON.parse(raw)).universe;
  };

  it("resolves tickers, aliases, and the BTC collision", async () => {
    const resolver = buildSecurityResolver(await loadUniverse());

    expect(resolver.resolve("IBIT", "iShares Bitcoin Trust")).toEqual({
      ticker: "IBIT",
      kind: "spot-etf",
    });
    expect(resolver.resolve("mstr", "Strategy Inc")).toEqual({
      ticker: "MSTR",
      kind: "treasury",
    });
    // Exchange ticker "BTC" is the Grayscale Mini Trust, never direct BTC.
    expect(resolver.resolve("BTC", "Grayscale Bitcoin Mini Trust ETF")).toEqual({
      ticker: "BTC",
      kind: "spot-etf",
    });
    // Non-ticker "Bitcoin" lines resolve via aliases to the direct pseudo-ticker.
    expect(resolver.resolve(null, "Bitcoin")).toEqual({ ticker: "BTC", kind: "direct" });
    expect(resolver.resolve(null, "BTC-USD")).toEqual({ ticker: "BTC", kind: "direct" });
    // Unrelated assets map to nothing.
    expect(resolver.resolve("AAPL", "Apple Inc.")).toBeNull();
    expect(resolver.resolve(null, "Rental property")).toBeNull();
  });
});

describe("member resolution", () => {
  const resolve = buildMemberResolver(MEMBERS);

  it("matches eFD filer names to senators", () => {
    expect(resolve("Bernie", "Moreno")?.bioguideId).toBe("M001239");
    expect(resolve("RICHARD ", "BLUMENTHAL")?.bioguideId).toBe("B001277");
    expect(resolve("Thomas H", "Tuberville")?.bioguideId).toBe("T000278");
  });

  it("never matches House members or unknown filers", () => {
    expect(resolve("Brandon", "Gill")).toBeNull();
    expect(resolve("John", "Galt")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

describe("resumable state", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it("advances lastSubmittedDate and accumulates ids", () => {
    const next = advanceSenateState(
      { lastSubmittedDate: "2026-07-01", processedFilingIds: ["a"] },
      [
        { filingId: "b", filedDate: "2026-07-24" },
        { filingId: "c", filedDate: "2026-07-10" },
      ],
    );
    expect(next.lastSubmittedDate).toBe("2026-07-24");
    expect(next.processedFilingIds).toEqual(["a", "b", "c"]);
  });

  it("round-trips through disk and defaults when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "senate-state-"));
    dirs.push(dir);
    const path = join(dir, "nested", "senate.json");

    expect(await loadSenateState(path)).toEqual(initialSenateState());
    const state = { lastSubmittedDate: "2026-07-24", processedFilingIds: ["x", "y"] };
    await saveSenateState(path, state);
    expect(await loadSenateState(path)).toEqual(state);
  });

  it("throws a typed error on a corrupt state file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "senate-state-"));
    dirs.push(dir);
    const path = join(dir, "senate.json");
    await writeFile(path, "{not json", "utf8");
    await expect(loadSenateState(path)).rejects.toThrow(SenateStateError);
    await writeFile(path, JSON.stringify({ nope: true }), "utf8");
    await expect(loadSenateState(path)).rejects.toThrow(SenateStateError);
  });
});

// ---------------------------------------------------------------------------
// End-to-end over fixtures (fake fetch; handshake + search + filing pages)
// ---------------------------------------------------------------------------

const HOME_HTML = `<!doctype html><html><body>
<form method="post">
<input type="hidden" name="csrfmiddlewaretoken" value="test-form-token">
<input type="checkbox" name="prohibition_agreement" value="1">
</form></body></html>`;

/** Fixture-backed eFD server; asserts the handshake happened before search. */
async function makeFakeEfd(): Promise<typeof fetch> {
  const searchJson = await fixture("search-ptr-page.json");
  const pages = new Map<string, string>([
    [MORENO_PTR_ID, await fixture("ptr-electronic.html")],
    [TUBERVILLE_PTR_ID, await fixture("ptr-electronic-tickers.html")],
    [TILLIS_ANNUAL_ID, await fixture("annual-electronic.html")],
  ]);
  const paperHtml = await fixture("paper-ptr.html");

  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const cookies = headers.get("cookie") ?? "";

    if (url.endsWith("/search/home/") && method === "GET") {
      return new Response(HOME_HTML, {
        status: 200,
        headers: [["set-cookie", "csrftoken=test-csrf; Path=/"]],
      });
    }
    if (url.endsWith("/search/home/") && method === "POST") {
      const body = String(init?.body);
      if (!body.includes("prohibition_agreement=1")) {
        return new Response("agreement not accepted", { status: 400 });
      }
      // Real site 302s to /search/ and sets the session cookie on the 302.
      return new Response(null, {
        status: 302,
        headers: [
          ["location", "/search/"],
          ["set-cookie", "sessionid=agreed; Path=/; HttpOnly"],
        ],
      });
    }
    if (url.endsWith("/search/") && method === "GET") {
      return new Response("<html>search</html>", { status: 200 });
    }
    if (url.endsWith("/search/report/data/") && method === "POST") {
      if (!cookies.includes("sessionid=agreed") || headers.get("x-csrftoken") !== "test-csrf") {
        return new Response("forbidden", { status: 403 });
      }
      const body = String(init?.body);
      if (body.includes(`report_types=${encodeURIComponent("[11]")}`)) {
        return new Response(searchJson, {
          status: 200,
          headers: [["content-type", "application/json"]],
        });
      }
      // Annual search: one row pointing at the captured annual report.
      const annualRow = [
        "Thomas",
        "Tillis",
        "Tillis, Thom (Senator)",
        `<a href="/search/view/annual/${TILLIS_ANNUAL_ID}/" target="_blank">Annual Report for CY 2024</a>`,
        "07/26/2026",
      ];
      return new Response(
        JSON.stringify({ recordsTotal: 1, recordsFiltered: 1, data: [annualRow] }),
        { status: 200, headers: [["content-type", "application/json"]] },
      );
    }

    const view = /\/search\/view\/(ptr|annual|paper)\/([0-9a-f-]{36})\//.exec(url);
    if (view && method === "GET") {
      if (!cookies.includes("sessionid=agreed")) {
        return new Response("agreement required", { status: 403 });
      }
      if (view[1] === "paper") return new Response(paperHtml, { status: 200 });
      const page = pages.get(view[2]!);
      if (page !== undefined) return new Response(page, { status: 200 });
      return new Response("not found", { status: 404 });
    }
    throw new Error(`fake eFD: unexpected ${method} ${url}`);
  };
}

describe("ingestSenate end-to-end over fixtures", () => {
  it("handshakes, searches incrementally, and maps filings to the contract", async () => {
    const universe: Security[] = [
      { ticker: "IBM", name: "International Business Machines Corporation Common", tier: 2, kind: "treasury" },
      { ticker: "BTC", name: "Bitcoin (direct holding)", tier: 1, kind: "direct", aliases: ["Bitcoin", "BTC-USD"] },
    ];
    const result = await ingestSenate({
      universe,
      members: MEMBERS,
      since: "2026-06-01",
      fetchImpl: await makeFakeEfd(),
    });

    // 23 PTR rows + 1 annual row, all processed or roster-skipped.
    expect(result.newFilingIds).toHaveLength(24);
    expect(result.state.lastSubmittedDate).toBe("2026-07-26");
    expect(result.state.processedFilingIds).toHaveLength(24);

    // Trades: Moreno 2 + Tuberville 11, contract-valid, correct provenance.
    expect(result.trades).toHaveLength(13);
    expect(result.trades.every((t) => isTrade(t))).toBe(true);
    const morenoTrades = result.trades.filter((t) => t.memberId === "M001239");
    expect(morenoTrades).toHaveLength(2);
    expect(morenoTrades[0]).toMatchObject({
      side: "sell",
      owner: "self",
      security: null,
      range: { lo: 1001, hi: 15000 },
      transactionDate: "2026-06-22",
      filedDate: "2026-07-24",
      docUrl: `https://efdsearch.senate.gov/search/view/ptr/${MORENO_PTR_ID}/`,
      late: false,
    });
    const tubervilleTrades = result.trades.filter((t) => t.memberId === "T000278");
    expect(tubervilleTrades).toHaveLength(11);
    expect(tubervilleTrades.every((t) => t.side === "sell" && !t.late)).toBe(true);

    // Holdings: only the universe-matched IBM row from the annual report.
    expect(result.holdings).toHaveLength(1);
    expect(isHolding(result.holdings[0])).toBe(true);
    expect(result.holdings[0]).toMatchObject({
      memberId: "T000476",
      security: { ticker: "IBM", kind: "treasury" },
      owner: "self",
      range: { lo: 100001, hi: 250000 },
      status: "holds",
      asOf: "2026-07-26",
      extraction: "efd-html",
      verification: "unverified",
    });
    expect(result.holdings[0]!.sources[0]).toMatchObject({
      kind: "filing",
      url: `https://efdsearch.senate.gov/search/view/annual/${TILLIS_ANNUAL_ID}/`,
    });

    // Paper filings -> OCR-flagged stubs carrying the scan GIF URLs.
    expect(result.paperStubs).toHaveLength(2);
    const blumenthal = result.paperStubs.find(
      (s) => s.filingId === BLUMENTHAL_PAPER_ID,
    )!;
    expect(blumenthal).toMatchObject({
      ocr: true,
      kind: "ptr",
      memberId: "B001277",
      filedDate: "2026-07-17",
    });
    expect(blumenthal.imageUrls).toHaveLength(5);

    // Electronic filings from filers off the roster are skipped with reasons.
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(
      result.skipped.every((s) => s.reason.includes("not on the member roster")),
    ).toBe(true);
  });

  it("is incremental: already-processed filings are not refetched", async () => {
    const fakeFetch = await makeFakeEfd();
    const first = await ingestSenate({
      universe: [],
      members: MEMBERS,
      since: "2026-06-01",
      fetchImpl: fakeFetch,
    });
    const second = await ingestSenate({
      universe: [],
      members: MEMBERS,
      state: first.state,
      fetchImpl: fakeFetch,
    });
    expect(second.newFilingIds).toHaveLength(0);
    expect(second.trades).toHaveLength(0);
    expect(second.paperStubs).toHaveLength(0);
    expect(second.state).toEqual(first.state);
  });

  it("persists resumable state to statePath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "senate-ingest-"));
    try {
      const statePath = join(dir, "senate-state.json");
      const result = await ingestSenate({
        universe: [],
        members: MEMBERS,
        since: "2026-06-01",
        statePath,
        fetchImpl: await makeFakeEfd(),
      });
      expect(await loadSenateState(statePath)).toEqual(result.state);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
