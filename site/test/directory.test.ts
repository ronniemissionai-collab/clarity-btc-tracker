// @vitest-environment happy-dom
/**
 * "All traders" directory: lazy index fetch, search by name/state, sort by
 * trade count / last trade / name, party + active filter chips, and honest
 * loading / error / empty states.
 */
import { describe, expect, it } from "vitest";
import { filterDirectory, renderDirectoryView } from "../src/components/directory";
import { parseDirectory, type DirectoryEntry } from "../src/portfolioData";
import indexFx from "./fixtures/portfolio/index.json";

const entries = parseDirectory(indexFx);

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function names(view: HTMLElement): string[] {
  return [...view.querySelectorAll("tbody a.dir-link")].map((a) => a.textContent ?? "");
}

async function loadedView(
  fixture: DirectoryEntry[] = entries,
): Promise<{ view: HTMLElement; calls: () => number }> {
  let calls = 0;
  const dir = renderDirectoryView(() => {
    calls += 1;
    return Promise.resolve(fixture);
  });
  dir.load();
  dir.load(); // second open must not refetch
  await flush();
  return { view: dir.view, calls: () => calls };
}

describe("directory contract parsing", () => {
  it("accepts the fixture index and rejects malformed entries", () => {
    expect(entries).toHaveLength(6);
    expect(() => parseDirectory([{ memberId: "nope" }])).toThrow(/memberId/);
    expect(() => parseDirectory({ not: "an array" })).toThrow(/expected an array/);
  });
});

describe("filterDirectory", () => {
  const base = {
    query: "",
    sort: "trades" as const,
    parties: new Set<DirectoryEntry["party"]>(),
    activeOnly: false,
  };

  it("sorts by trade count, last trade date, and name", () => {
    expect(filterDirectory(entries, base)[0]?.name).toBe("Gil Cisneros");
    expect(filterDirectory(entries, { ...base, sort: "lastTrade" }).map((e) => e.memberId).slice(0, 2)).toEqual([
      "C001123",
      "M001243",
    ]);
    const byName = filterDirectory(entries, { ...base, sort: "name" }).map((e) => e.name);
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b)));
  });

  it("matches names substring-style and states exactly", () => {
    expect(filterDirectory(entries, { ...base, query: "pelosi" })).toHaveLength(1);
    expect(filterDirectory(entries, { ...base, query: "WY" }).map((e) => e.name)).toEqual([
      "Cynthia Lummis",
    ]);
    // "ca" must not sweep in every California member by accident of substring:
    // states match exactly, names by substring.
    const ca = filterDirectory(entries, { ...base, query: "ca" });
    expect(ca.map((e) => e.state).every((s) => s === "CA")).toBe(true);
  });

  it("applies party and active-only chips", () => {
    const reps = filterDirectory(entries, { ...base, parties: new Set(["R" as const]) });
    expect(reps.every((e) => e.party === "R")).toBe(true);
    expect(reps).toHaveLength(4);
    const active = filterDirectory(entries, {
      ...base,
      parties: new Set(["R" as const]),
      activeOnly: true,
    });
    expect(active.map((e) => e.name)).not.toContain("Marjorie Taylor Greene");
    expect(active).toHaveLength(3);
  });
});

describe("directory view", () => {
  it("shows a loading state, fetches once, then renders every entry", async () => {
    const { view, calls } = await loadedView();
    expect(calls()).toBe(1);
    expect(names(view)).toHaveLength(6);
    expect(view.textContent).toContain("6 members with disclosed trades");
    // Rows link to the member route.
    const link = view.querySelector<HTMLAnchorElement>("tbody a.dir-link");
    expect(link?.getAttribute("href")).toMatch(/^#member\/[A-Z]\d{6}$/);
  });

  it("flags departed members and roster members with chips", async () => {
    const { view } = await loadedView();
    const mtgRow = [...view.querySelectorAll("tbody tr")].find((tr) =>
      tr.textContent?.includes("Marjorie Taylor Greene"),
    );
    expect(mtgRow?.textContent).toContain("no longer serving");
    const pelosiRow = [...view.querySelectorAll("tbody tr")].find((tr) =>
      tr.textContent?.includes("Nancy Pelosi"),
    );
    expect(pelosiRow?.textContent).toContain("tracked");
  });

  it("search box narrows by name/state and shows an honest empty state", async () => {
    const { view } = await loadedView();
    const search = view.querySelector<HTMLInputElement>("input[type=search]");
    if (!search) throw new Error("search box missing");
    search.value = "lummis";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(names(view)).toEqual(["Cynthia Lummis"]);
    expect(view.textContent).toContain("1 of 6 members match");

    search.value = "zz";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(names(view)).toEqual([]);
    expect(view.textContent).toContain("No members match the current search and filters.");
  });

  it("sort select reorders rows", async () => {
    const { view } = await loadedView();
    const sort = view.querySelector<HTMLSelectElement>("select");
    if (!sort) throw new Error("sort select missing");
    sort.value = "name";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
    expect(names(view)[0]).toBe("Cynthia Lummis");
    sort.value = "lastTrade";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
    expect(names(view)[0]).toBe("Gil Cisneros");
  });

  it("party and serving-now chips toggle with aria-pressed", async () => {
    const { view } = await loadedView();
    const chips = [...view.querySelectorAll<HTMLButtonElement>("button.chip-btn")];
    const dem = chips.find((c) => c.textContent === "D");
    const serving = chips.find((c) => c.textContent === "serving now");
    if (!dem || !serving) throw new Error("filter chips missing");

    dem.click();
    expect(dem.getAttribute("aria-pressed")).toBe("true");
    expect(names(view)).toEqual(["Gil Cisneros", "Nancy Pelosi"]);

    dem.click();
    serving.click();
    expect(names(view)).not.toContain("Marjorie Taylor Greene");
    expect(names(view)).toHaveLength(5);
  });

  it("renders an error state with a retry that refetches", async () => {
    let calls = 0;
    const dir = renderDirectoryView(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("HTTP 404"))
        : Promise.resolve(entries);
    });
    dir.load();
    await flush();
    expect(dir.view.textContent).toContain("The member directory failed to load.");
    expect(dir.view.textContent).toContain("HTTP 404");

    dir.view.querySelector<HTMLButtonElement>("button.show-more")?.click();
    await flush();
    expect(calls).toBe(2);
    expect(names(dir.view)).toHaveLength(6);
  });
});
