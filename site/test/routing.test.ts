// @vitest-environment happy-dom
/**
 * Hash-routing smoke test over the real entry point (and the real data/
 * files): home renders three tabs, #member/{id} swaps to the lazily fetched
 * member view, and navigating back to #directory restores the home page with
 * the "All traders" tab selected.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import indexFx from "./fixtures/portfolio/index.json";
import pelosiFx from "./fixtures/portfolio/P000197.json";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function jsonResponse(body: unknown): Pick<Response, "ok" | "status" | "json"> {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith("/data/portfolio/index.json")) return Promise.resolve(jsonResponse(indexFx));
  if (url.endsWith("/data/portfolio/P000197.json")) return Promise.resolve(jsonResponse(pelosiFx));
  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
});

const goto = async (hash: string): Promise<void> => {
  location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
  await flush();
};

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  document.body.innerHTML = '<div id="app"></div>';
  await import("../src/main");
});

describe("hash routing", () => {
  it("renders the home page with three tabs and no eager portfolio fetch", () => {
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(["Bitcoin holdings", "Portfolio tracker", "All traders"]);
    expect(document.querySelector("h1")?.textContent).toContain("hold Bitcoin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes #member/{id} to the member view with a working back link", async () => {
    await goto("#member/P000197");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector("h1")?.textContent).toBe("Nancy Pelosi");
    expect(document.querySelector<HTMLAnchorElement>("a.back-link")?.getAttribute("href")).toBe(
      "#directory",
    );
  });

  it("routes #directory back home with the All traders tab open and lazily loads the index", async () => {
    await goto("#directory");
    const directoryTab = document.querySelector('[role="tab"][id="tab-directory"]');
    expect(directoryTab?.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("#panel-directory")?.textContent).toContain(
      "6 members with disclosed trades",
    );
    // Re-entering the directory must not refetch the index.
    await goto("#member/P000197");
    await goto("#directory");
    expect(fetchMock).toHaveBeenCalledTimes(2); // one index + one member fetch total
  });
});
