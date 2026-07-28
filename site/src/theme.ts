/**
 * Theme control: light + dark via CSS tokens. Default follows
 * prefers-color-scheme; the toggle sets a data-theme override on <html>
 * (the token pattern from the approved prototype) and persists it.
 */

type ThemePref = "auto" | "light" | "dark";
const STORAGE_KEY = "clarity-btc-theme";
const ORDER: readonly ThemePref[] = ["auto", "light", "dark"];

function readPref(): ThemePref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : "auto";
  } catch {
    return "auto";
  }
}

function applyPref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "auto") delete root.dataset["theme"];
  else root.dataset["theme"] = pref;
  try {
    if (pref === "auto") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Private-mode storage failures are fine; the choice just won't persist.
  }
}

export function createThemeToggle(): HTMLButtonElement {
  let pref = readPref();
  applyPref(pref);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "theme-toggle";

  const label = (p: ThemePref): string =>
    p === "auto" ? "Theme: auto" : p === "light" ? "Theme: light" : "Theme: dark";
  button.textContent = label(pref);

  button.addEventListener("click", () => {
    pref = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length] ?? "auto";
    applyPref(pref);
    button.textContent = label(pref);
  });
  return button;
}
