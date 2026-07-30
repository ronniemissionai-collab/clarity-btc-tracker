/**
 * Entry point: load + validate the small data files, derive the view model,
 * and assemble the approved Variant D composite — hero, bill stage strip with
 * substitute warning and news strip, four tabs (holdings / portfolio / all
 * traders / common holdings), and the methodology footer.
 *
 * Routing is location.hash based:
 *   ""            → home (tabs)
 *   "#directory"  → home with the "All traders" tab selected
 *   "#member/{id}"→ member portfolio view (lazy /data/portfolio/{id}.json)
 * The browser back button walks hash history, so back from a member view
 * returns to wherever the reader came from.
 */
import "./styles.css";
import { loadData, type AppData } from "./data";
import { buildModel } from "./derive";
import { el } from "./dom";
import { renderBillStrip } from "./components/billStrip";
import { renderCommonHoldingsView } from "./components/commonHoldings";
import { renderDirectoryView } from "./components/directory";
import { renderFooter } from "./components/footer";
import { renderHero } from "./components/hero";
import { renderHoldingsView } from "./components/holdingsView";
import { renderMemberPage } from "./components/memberDetail";
import { createTabs, type Tabs } from "./components/tabs";
import { renderPortfolioView } from "./components/traderCards";
import { createThemeToggle } from "./theme";

const MEMBER_ROUTE = /^#member\/([A-Z]\d{6})$/;

const app = document.querySelector<HTMLDivElement>("#app");
if (app === null) {
  throw new Error("missing #app mount point");
}

function renderError(mount: HTMLElement, error: unknown): void {
  const box = el("div", { class: "wrap" });
  box.appendChild(el("h1", {}, "Data failed validation"));
  box.appendChild(
    el(
      "p",
      { class: "muted" },
      "The page refuses to render numbers it cannot trust. Details below; the pipeline keeps the last good data on failure.",
    ),
  );
  box.appendChild(el("pre", { class: "errbox" }, error instanceof Error ? error.message : String(error)));
  mount.replaceChildren(box);
}

/** The home page (hero + strip + tabs) — built once, reused across routes. */
function buildHomePage(data: AppData): { page: HTMLElement; tabs: Tabs } {
  const model = buildModel(data);

  const wrap = el("div", { class: "wrap" });

  const skip = el("a", { class: "skip-link", href: "#main" }, "Skip to content");
  wrap.appendChild(skip);

  wrap.appendChild(renderHero(model, data.meta));
  wrap.appendChild(renderBillStrip(data.bill, data.news, data.meta));

  if (!data.meta.run.ok) {
    wrap.appendChild(
      el(
        "p",
        { class: "subnote", role: "status" },
        "⚠ The latest data run failed validation; this page shows the last good data.",
      ),
    );
  }

  const directory = renderDirectoryView();
  const common = renderCommonHoldingsView();
  const main = el("main", { id: "main" });
  const tabs = createTabs([
    { id: "holdings", label: "Bitcoin holdings", panel: renderHoldingsView(model) },
    { id: "portfolio", label: "Portfolio tracker", panel: renderPortfolioView(model, data.meta) },
    { id: "directory", label: "All traders", panel: directory.view, onShow: directory.load },
    { id: "common", label: "Common holdings", panel: common.view, onShow: common.load },
  ]);
  main.appendChild(tabs.nav);
  for (const panel of tabs.panels) main.appendChild(panel);
  wrap.appendChild(main);

  wrap.appendChild(renderFooter(data.meta));
  return { page: wrap, tabs };
}

/** A member portfolio page: back link + lazily fetched detail + footer. */
function buildMemberPage(memberId: string, data: AppData): HTMLElement {
  const wrap = el("div", { class: "wrap" });
  const topbar = el("div", { class: "topbar member-topbar" });
  topbar.appendChild(el("a", { class: "back-link", href: "#directory" }, "← All traders"));
  topbar.appendChild(createThemeToggle());
  wrap.appendChild(topbar);

  const main = el("main", { id: "main", tabindex: -1 });
  main.appendChild(renderMemberPage(memberId));
  wrap.appendChild(main);

  wrap.appendChild(renderFooter(data.meta));
  return wrap;
}

function start(mount: HTMLElement): void {
  const data = loadData();
  const home = buildHomePage(data);

  const route = (): void => {
    const member = MEMBER_ROUTE.exec(location.hash);
    if (member?.[1] !== undefined) {
      const page = buildMemberPage(member[1], data);
      mount.replaceChildren(page);
      window.scrollTo(0, 0);
      page.querySelector<HTMLElement>("main")?.focus();
      return;
    }
    if (mount.firstChild !== home.page) {
      mount.replaceChildren(home.page);
      window.scrollTo(0, 0);
    }
    if (location.hash === "#directory") home.tabs.select("directory");
  };

  window.addEventListener("hashchange", route);
  route();
}

try {
  start(app);
} catch (error) {
  renderError(app, error);
  console.error(error);
}
