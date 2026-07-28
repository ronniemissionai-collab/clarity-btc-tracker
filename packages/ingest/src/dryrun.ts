/**
 * Fixture-backed PipelineIO for --dry-run and the pipeline e2e test.
 *
 * Serves the live-captured fixtures committed under packages/ingest/test/
 * fixtures/ (House Clerk 2026 index + one e-filed PTR, the Senate eFD
 * handshake/search/filing pages, all five kadoa datasets + per-filer files,
 * two real Exa responses, the four bill XML sources, and the SPY Yahoo
 * chart). Every step of the pipeline executes end-to-end with ZERO network:
 * any URL that has no fixture gets a 404 (or throws, for the bill sources),
 * exercising the same degradation paths a flaky day would.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { houseIndexUrl, ptrPdfUrl } from "./house/urls.js";
import { parseHouseIndexZip } from "./house/indexParser.js";
import { emptyHouseState, saveHouseState, withSeenDocIds } from "./house/state.js";
import { KADOA_BASE_URL } from "./kadoa/fetch.js";
import type { KadoaFetchFn } from "./kadoa/fetch.js";
import { BILLSTATUS_URL, senateVoteMenuUrl } from "./bill/refresh.js";
import type { FetchText } from "./bill/refresh.js";
import type { YahooFetchFn } from "./returns/yahoo.js";
import type { PipelineIO } from "./pipeline.js";

/** Fixture root: packages/ingest/test/fixtures/ (committed, live-captured). */
export const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures",
);

/** Dry-run expectations tuned to the fixture world (real config expects 15+). */
export const DRY_RUN_EXPECTATIONS_PATH = path.join(FIXTURES_DIR, "pipeline", "expectations.json");

/** The fixture capture date - anchors every recency window deterministically. */
export const DRY_RUN_NOW = "2026-07-28";

const HOUSE_YEAR = 2026;
/** DocIDs the fixture server actually serves (one e-filed PTR, one paper scan). */
const HOUSE_SERVED_DOCIDS = ["20034195", "8221321"];

function fixture(...segments: string[]): Promise<Buffer> {
  return readFile(path.join(FIXTURES_DIR, ...segments));
}

async function fixtureText(...segments: string[]): Promise<string> {
  return (await fixture(...segments)).toString("utf8");
}

// ---------------------------------------------------------------------------
// House Clerk
// ---------------------------------------------------------------------------

function makeHouseFetch(indexZip: Uint8Array, biggsPdf: Uint8Array): typeof fetch {
  return ((input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const body = (bytes: Uint8Array): Response =>
      new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 });
    if (url === houseIndexUrl(HOUSE_YEAR)) return Promise.resolve(body(indexZip));
    if (url === ptrPdfUrl(HOUSE_YEAR, "20034195")) return Promise.resolve(body(biggsPdf));
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

/**
 * Pre-seed the House state so only the fixture-served DocIDs are "new" -
 * without this, all 318 index PTRs would 404 against the fixture server and
 * pile up as retryable issues.
 */
export async function seedDryRunState(stateDir: string): Promise<void> {
  const indexZip = new Uint8Array(await fixture("house", "2026FD.zip"));
  const seen = new Set(
    parseHouseIndexZip(indexZip, HOUSE_YEAR)
      .filter((f) => f.filingType === "P" && !HOUSE_SERVED_DOCIDS.includes(f.docId))
      .map((f) => f.docId),
  );
  await saveHouseState(
    path.join(stateDir, "house-state.json"),
    withSeenDocIds(emptyHouseState(), HOUSE_YEAR, seen),
  );
}

// ---------------------------------------------------------------------------
// Senate eFD (CSRF/agreement handshake + DataTables search + filing pages)
// ---------------------------------------------------------------------------

const EFD_HOME_HTML = `<!doctype html><html><body>
<form method="post">
<input type="hidden" name="csrfmiddlewaretoken" value="dry-run-form-token">
<input type="checkbox" name="prohibition_agreement" value="1">
</form></body></html>`;

const SENATE_PAGES: Record<string, string> = {
  "bccf83ce-dd72-4ab6-8564-b3bbb1d2ee55": "ptr-electronic.html",
  "392ac3e5-07f6-4f8c-840f-84e9066ffb29": "ptr-electronic-tickers.html",
  "cb89b62d-ebfa-4739-abb0-3ce34f5533b3": "annual-electronic.html",
};

/**
 * Roster members in the captured search page whose filing pages were not
 * captured get a structurally valid, EMPTY filing - the parser runs for real
 * and honestly yields zero rows (no fabricated transactions).
 */
const EMPTY_PTR_HTML = `<!doctype html><html><body>
<h1>Periodic Transaction Report</h1><p>Filed 07/24/2026</p>
<table><thead><tr><th>#</th><th>Transaction Date</th><th>Owner</th><th>Ticker</th>
<th>Asset Name</th><th>Asset Type</th><th>Type</th><th>Amount</th><th>Comment</th></tr></thead>
<tbody></tbody></table></body></html>`;

const EMPTY_ANNUAL_HTML = `<!doctype html><html><body>
<h1>Annual Report</h1><p>Filed 07/26/2026</p>
<h2>Part 3. Assets</h2><table><tbody></tbody></table>
<h2>Part 4a. Periodic Transaction Report Summary</h2></body></html>`;

async function makeSenateFetch(): Promise<typeof fetch> {
  const searchJson = await fixtureText("senate", "search-ptr-page.json");
  const paperHtml = await fixtureText("senate", "paper-ptr.html");
  const pages = new Map<string, string>();
  for (const [id, file] of Object.entries(SENATE_PAGES)) {
    pages.set(id, await fixtureText("senate", file));
  }

  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const cookies = new Headers(init?.headers).get("cookie") ?? "";

    if (url.endsWith("/search/home/") && method === "GET") {
      return new Response(EFD_HOME_HTML, {
        status: 200,
        headers: [["set-cookie", "csrftoken=dry-run-csrf; Path=/"]],
      });
    }
    if (url.endsWith("/search/home/") && method === "POST") {
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
        `<a href="/search/view/annual/cb89b62d-ebfa-4739-abb0-3ce34f5533b3/" target="_blank">Annual Report for CY 2024</a>`,
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
      return new Response(view[1] === "annual" ? EMPTY_ANNUAL_HTML : EMPTY_PTR_HTML, {
        status: 200,
      });
    }
    throw new Error(`dry-run eFD: unexpected ${method} ${url}`);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// kadoa, Exa, bill XML, Yahoo
// ---------------------------------------------------------------------------

function makeKadoaFetch(): KadoaFetchFn {
  return async (url) => {
    const prefix = `${KADOA_BASE_URL}/`;
    if (!url.startsWith(prefix)) {
      return { ok: false, status: 404, text: () => Promise.resolve("not a kadoa url") };
    }
    const relPath = url.slice(prefix.length);
    try {
      const body = await fixtureText("kadoa", ...relPath.split("/"));
      return { ok: true, status: 200, text: () => Promise.resolve(body) };
    } catch {
      // Per-filer histories exist only for the five captured members; the
      // fetch layer treats a 404 as "no backfill for that member".
      return { ok: false, status: 404, text: () => Promise.resolve("no fixture") };
    }
  };
}

async function makeExaFetch(): Promise<typeof fetch> {
  const newsBody = await fixtureText("review", "search-news.json");
  const corroborationBody = await fixtureText("review", "search-corroboration.json");
  return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
    };
    const query = body.query ?? "";
    const isNews = query.includes("CLARITY Act") || query.includes("holdings disclosure");
    return new Response(isNews ? newsBody : corroborationBody, {
      status: 200,
      headers: [["content-type", "application/json"]],
    });
  }) as typeof fetch;
}

async function makeBillFetchText(): Promise<FetchText> {
  const billstatusXml = await fixtureText("bill", "billstatus-119hr3633.xml");
  const houseRollXml = await fixtureText("bill", "house-roll199.xml");
  const senateMenuXml = await fixtureText("bill", "senate-vote-menu-119-2.xml");
  const senateDetailXml = await fixtureText("bill", "senate-vote-119-2-00001.xml");
  return (url) => {
    if (url === BILLSTATUS_URL) return Promise.resolve(billstatusXml);
    if (url.endsWith("roll199.xml")) return Promise.resolve(houseRollXml);
    if (url === senateVoteMenuUrl(119, 2)) return Promise.resolve(senateMenuXml);
    if (url.includes("/roll_call_votes/")) return Promise.resolve(senateDetailXml);
    return Promise.reject(new Error(`dry-run bill fetch: no fixture for ${url}`));
  };
}

async function makeYahooFetch(): Promise<YahooFetchFn> {
  const spyBody = await fixtureText("yahoo", "spy-3mo.json");
  return (url) => {
    if (/\/chart\/SPY(\?|$)/.test(url)) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(spyBody) });
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve("no fixture series"),
    });
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Build the fixture-backed IO (zero network). Pair with seedDryRunState(). */
export async function createDryRunIO(): Promise<PipelineIO> {
  const indexZip = new Uint8Array(await fixture("house", "2026FD.zip"));
  const biggsPdf = new Uint8Array(await fixture("house", "20034195.pdf"));
  return {
    houseFetch: makeHouseFetch(indexZip, biggsPdf),
    houseYear: HOUSE_YEAR,
    senateFetch: await makeSenateFetch(),
    kadoaFetch: makeKadoaFetch(),
    exaFetch: await makeExaFetch(),
    exaApiKey: "dry-run-fixture-key",
    billFetchText: await makeBillFetchText(),
    yahooFetch: await makeYahooFetch(),
    now: DRY_RUN_NOW,
  };
}
