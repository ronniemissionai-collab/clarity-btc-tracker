/**
 * Fetch-based client for efdsearch.senate.gov (Senate electronic Financial
 * Disclosure system). Implements the Django CSRF + prohibition-agreement
 * handshake verified live in research ticket 09:
 *
 *   1. GET  /search/home/   -> csrftoken cookie + hidden csrfmiddlewaretoken
 *   2. POST /search/home/   -> csrfmiddlewaretoken + prohibition_agreement=1
 *                              (Referer required) -> sessionid cookie carries
 *                              the accepted agreement
 *   3. POST /search/report/data/ -> DataTables JSON (X-CSRFToken header)
 *
 * Cookies live in an in-memory jar; redirects are followed manually so
 * Set-Cookie headers on intermediate 30x responses are not lost.
 */
import {
  SenateFilingError,
  SenateHandshakeError,
  SenateSearchError,
} from "./errors.js";

export const EFD_BASE_URL = "https://efdsearch.senate.gov";

/** eFD report-type ids (the values POSTed in `report_types`). */
export const EFD_REPORT_TYPE = {
  annual: 7,
  ptr: 11,
} as const;

/** Raw DataTables response from POST /search/report/data/. */
export interface EfdSearchResponse {
  recordsTotal: number;
  recordsFiltered: number;
  /** One row per filing: [first, last, filer label, link HTML, MM/DD/YYYY]. */
  data: string[][];
}

export interface EfdSearchQuery {
  /** eFD report-type ids, e.g. [11] for PTRs, [7] for annual reports. */
  reportTypes: number[];
  /** Inclusive lower bound on the submitted date, ISO YYYY-MM-DD. */
  submittedStartDate?: string;
  start: number;
  length: number;
}

/** Minimal in-memory cookie jar (name -> value, single origin). */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0];
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export interface EfdClientOptions {
  /** Injectable fetch (tests pass a fixture-backed fake; no network). */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
}

/** Convert ISO YYYY-MM-DD to the "MM/DD/YYYY 00:00:00" form eFD expects. */
export function toEfdDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new SenateSearchError(`invalid ISO date for eFD filter: "${isoDate}"`);
  return `${m[2]}/${m[3]}/${m[1]} 00:00:00`;
}

export class EfdClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly jar = new CookieJar();
  private agreed = false;

  constructor(options: EfdClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? EFD_BASE_URL;
    this.userAgent =
      options.userAgent ??
      "clarity-btc-tracker/0.1 (public STOCK Act disclosure research)";
  }

  /** Absolute URL for a server-relative eFD path. */
  resolveUrl(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  /**
   * Fetch with the cookie jar attached, absorbing Set-Cookie at every hop
   * (redirects followed manually so intermediate cookies are kept).
   */
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    let currentUrl = url;
    let currentInit = init;
    for (let hop = 0; hop < 6; hop++) {
      const headers = new Headers(currentInit.headers);
      headers.set("User-Agent", this.userAgent);
      const cookie = this.jar.header();
      if (cookie) headers.set("Cookie", cookie);
      const response = await this.fetchImpl(currentUrl, {
        ...currentInit,
        headers,
        redirect: "manual",
      });
      this.jar.absorb(response);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        currentUrl = new URL(location, currentUrl).toString();
        currentInit = { method: "GET" }; // 301/302/303: redirect with GET
        continue;
      }
      return response;
    }
    throw new SenateFilingError(`too many redirects fetching ${url}`);
  }

  /**
   * Steps 1+2: obtain the csrftoken cookie and accept the prohibition
   * agreement so the session may query search endpoints. Idempotent.
   */
  async handshake(): Promise<void> {
    if (this.agreed) return;
    const homeUrl = this.resolveUrl("/search/home/");

    const home = await this.request(homeUrl);
    if (!home.ok) {
      throw new SenateHandshakeError(`GET /search/home/ returned ${home.status}`);
    }
    const homeHtml = await home.text();
    const tokenMatch = /name="csrfmiddlewaretoken"\s+value="([^"]+)"/.exec(homeHtml);
    if (!tokenMatch?.[1]) {
      throw new SenateHandshakeError(
        "csrfmiddlewaretoken input not found on /search/home/",
      );
    }

    const body = new URLSearchParams({
      csrfmiddlewaretoken: tokenMatch[1],
      prohibition_agreement: "1",
    });
    const agree = await this.request(homeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: homeUrl,
      },
      body: body.toString(),
    });
    if (!agree.ok) {
      throw new SenateHandshakeError(
        `POST /search/home/ (prohibition agreement) returned ${agree.status}`,
      );
    }
    if (!this.jar.get("csrftoken")) {
      throw new SenateHandshakeError("no csrftoken cookie after handshake");
    }
    this.agreed = true;
  }

  /** Step 3: one page of the DataTables search endpoint. */
  async searchPage(query: EfdSearchQuery): Promise<EfdSearchResponse> {
    await this.handshake();
    const csrftoken = this.jar.get("csrftoken");
    if (!csrftoken) throw new SenateHandshakeError("csrftoken cookie missing");

    const body = new URLSearchParams({
      start: String(query.start),
      length: String(query.length),
      report_types: `[${query.reportTypes.join(",")}]`,
      filer_types: "[]",
      submitted_start_date: query.submittedStartDate
        ? toEfdDate(query.submittedStartDate)
        : "",
      submitted_end_date: "",
      candidate_state: "",
      senator_state: "",
      office_id: "",
      first_name: "",
      last_name: "",
    });
    const response = await this.request(this.resolveUrl("/search/report/data/"), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRFToken": csrftoken,
        "X-Requested-With": "XMLHttpRequest",
        Referer: this.resolveUrl("/search/"),
      },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new SenateSearchError(`/search/report/data/ returned ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new SenateSearchError("/search/report/data/ returned non-JSON body", {
        cause,
      });
    }
    return validateSearchResponse(payload);
  }

  /** All rows for a query, paginating start/length until recordsTotal. */
  async searchAll(
    query: Omit<EfdSearchQuery, "start" | "length">,
    pageSize = 100,
  ): Promise<string[][]> {
    const rows: string[][] = [];
    for (let start = 0; ; start += pageSize) {
      const page = await this.searchPage({ ...query, start, length: pageSize });
      rows.push(...page.data);
      if (rows.length >= page.recordsTotal || page.data.length === 0) break;
    }
    return rows;
  }

  /** Fetch a filing page (/search/view/ptr|annual|paper/{uuid}/) as HTML. */
  async fetchFilingHtml(url: string): Promise<string> {
    await this.handshake();
    const response = await this.request(url, {
      headers: { Referer: this.resolveUrl("/search/") },
    });
    if (!response.ok) {
      throw new SenateFilingError(`GET ${url} returned ${response.status}`);
    }
    return response.text();
  }
}

function validateSearchResponse(payload: unknown): EfdSearchResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new SenateSearchError("search response is not an object");
  }
  const p = payload as Record<string, unknown>;
  const { recordsTotal, recordsFiltered, data } = p;
  if (typeof recordsTotal !== "number" || !Array.isArray(data)) {
    throw new SenateSearchError(
      "search response missing recordsTotal/data (DataTables shape expected)",
    );
  }
  for (const row of data) {
    if (!Array.isArray(row) || !row.every((c) => typeof c === "string")) {
      throw new SenateSearchError("search response row is not a string array");
    }
  }
  return {
    recordsTotal,
    recordsFiltered:
      typeof recordsFiltered === "number" ? recordsFiltered : recordsTotal,
    data: data as string[][],
  };
}
