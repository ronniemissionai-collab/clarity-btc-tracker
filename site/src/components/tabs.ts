/**
 * Accessible tab navigation (Bitcoin holdings / Portfolio tracker / All
 * traders / Common holdings): proper tab semantics, roving tabindex,
 * arrow-key + Home/End support. `onShow` fires each time a tab is selected —
 * the directory and common-holdings tabs use it to lazy-fetch their data on
 * first open.
 */
import { el } from "../dom";

export interface TabDef {
  id: string;
  label: string;
  panel: HTMLElement;
  /** Called every time this tab is selected (not for the initial tab). */
  onShow?: () => void;
}

export interface Tabs {
  nav: HTMLElement;
  panels: HTMLElement[];
  /** Programmatic selection by tab id (used by the #directory hash route). */
  select: (id: string) => void;
}

export function createTabs(defs: TabDef[]): Tabs {
  const nav = el("div", { class: "tabs", role: "tablist", "aria-label": "Views" });
  const buttons: HTMLButtonElement[] = [];
  const panels: HTMLElement[] = [];

  const select = (index: number, focus: boolean): void => {
    defs.forEach((def, i) => {
      const on = i === index;
      const button = buttons[i];
      const panel = panels[i];
      if (!button || !panel) return;
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
      button.classList.toggle("on", on);
      panel.hidden = !on;
    });
    if (focus) buttons[index]?.focus();
    defs[index]?.onShow?.();
  };

  defs.forEach((def, i) => {
    const button = el(
      "button",
      {
        class: "tab",
        role: "tab",
        id: `tab-${def.id}`,
        "aria-controls": `panel-${def.id}`,
        "aria-selected": String(i === 0),
        type: "button",
      },
      def.label,
    );
    button.tabIndex = i === 0 ? 0 : -1;
    button.addEventListener("click", () => select(i, false));
    button.addEventListener("keydown", (event) => {
      const last = defs.length - 1;
      let next: number | null = null;
      if (event.key === "ArrowRight") next = i === last ? 0 : i + 1;
      else if (event.key === "ArrowLeft") next = i === 0 ? last : i - 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = last;
      if (next !== null) {
        event.preventDefault();
        select(next, true);
      }
    });
    buttons.push(button);
    nav.appendChild(button);

    def.panel.id = `panel-${def.id}`;
    def.panel.setAttribute("role", "tabpanel");
    def.panel.setAttribute("aria-labelledby", `tab-${def.id}`);
    def.panel.tabIndex = 0;
    def.panel.hidden = i !== 0;
    panels.push(def.panel);
  });

  return {
    nav,
    panels,
    select: (id) => {
      const index = defs.findIndex((def) => def.id === id);
      if (index >= 0) select(index, false);
    },
  };
}
