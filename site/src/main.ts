/**
 * Entry point: load + validate the seven data files, derive the view model,
 * and assemble the approved Variant D composite — hero, bill stage strip with
 * substitute warning and news strip, two tabs (holdings / portfolio), and the
 * methodology footer.
 */
import "./styles.css";
import { loadData } from "./data";
import { buildModel } from "./derive";
import { el } from "./dom";
import { renderBillStrip } from "./components/billStrip";
import { renderFooter } from "./components/footer";
import { renderHero } from "./components/hero";
import { renderHoldingsView } from "./components/holdingsView";
import { createTabs } from "./components/tabs";
import { renderPortfolioView } from "./components/traderCards";

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

function render(mount: HTMLElement): void {
  const data = loadData();
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

  const main = el("main", { id: "main" });
  const tabs = createTabs([
    { id: "holdings", label: "Bitcoin holdings", panel: renderHoldingsView(model) },
    { id: "portfolio", label: "Portfolio tracker", panel: renderPortfolioView(model, data.meta) },
  ]);
  main.appendChild(tabs.nav);
  for (const panel of tabs.panels) main.appendChild(panel);
  wrap.appendChild(main);

  wrap.appendChild(renderFooter(data.meta));
  mount.replaceChildren(wrap);
}

try {
  render(app);
} catch (error) {
  renderError(app, error);
  console.error(error);
}
