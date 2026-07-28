/**
 * Bill status block (Variant A organ): horizontal stage strip with the
 * current stage accented, the substitute-text warning callout immediately
 * beneath, then the compact Exa-fed "Latest reporting" news strip — placed
 * here because official actions can sit static for months while the real
 * negotiation happens off-calendar.
 */
import type { Bill, Meta, NewsItem } from "@clarity-btc/shared";
import { el } from "../dom";
import { fmtDate } from "../format";

function stageDateLabel(status: "done" | "current" | "pending", date: string | null): string {
  if (date) return fmtDate(date);
  return status === "current" ? "not scheduled" : "pending";
}

export function renderBillStrip(bill: Bill, news: NewsItem[], meta: Meta): HTMLElement {
  const section = el("section", { class: "bill", "aria-label": "Bill status" });

  // Stage strip
  const strip = el("ol", { class: "stages", "aria-label": `${bill.shortTitle ?? bill.title} timeline` });
  for (const stage of bill.stages) {
    const item = el("li", { class: `stage ${stage.status}` });
    const dotAttrs: Record<string, string> = { class: "dot", "aria-hidden": "true" };
    item.appendChild(el("span", dotAttrs));
    const text = el("span", {});
    const label = el("b", {}, stage.label);
    if (stage.status === "current") {
      label.append(" ", el("span", { class: "visually-hidden" }, "(current stage)"));
    }
    text.appendChild(label);
    text.appendChild(el("br"));
    const dateAttrs: Record<string, string> = { class: "stage-date" };
    if (stage.detail !== undefined) dateAttrs["title"] = stage.detail;
    text.appendChild(el("small", dateAttrs, stageDateLabel(stage.status, stage.date)));
    item.appendChild(text);
    strip.appendChild(item);
  }
  section.appendChild(strip);

  // Substitute-text warning: a Senate pass must never read as the House text becoming law.
  if (bill.substituteWarning) {
    const warning = el("p", { class: "subnote", role: "note" });
    warning.append(el("strong", {}, "⚠ Substitute text: "), bill.substituteWarning);
    section.appendChild(warning);
  }

  // Latest reporting strip
  if (news.length > 0) {
    const strip2 = el("aside", { class: "news", "aria-label": "Latest reporting" });
    strip2.appendChild(
      el(
        "p",
        { class: "eyebrow news-head" },
        `Latest reporting · as of ${fmtDate(meta.asOf.news)}`,
      ),
    );
    const list = el("ul", { class: "news-list" });
    const sorted = [...news].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    for (const item of sorted) {
      const li = el("li", { class: "news-item" });
      const linkAttrs: Record<string, string> = {
        href: item.url,
        rel: "noopener",
      };
      if (item.summary !== undefined) linkAttrs["title"] = item.summary;
      li.appendChild(el("a", linkAttrs, item.title));
      li.appendChild(el("small", { class: "news-meta" }, ` ${item.source} · ${fmtDate(item.publishedAt)}`));
      list.appendChild(li);
    }
    strip2.appendChild(list);
    section.appendChild(strip2);
  }

  return section;
}
