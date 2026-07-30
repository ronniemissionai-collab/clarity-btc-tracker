/**
 * Epistemics chips — the non-negotiables from the disclaimers ticket rendered
 * as one consistent vocabulary: party, vote, owner attribution, extraction
 * quality (OCR), verification (unverified / conflicting), and SOLD/stale.
 */
import type { Holding, PortfolioPosition, Member } from "@clarity-btc/shared";
import { el } from "../dom";
import { fmtMonthYear } from "../format";
import type { VoteStatus } from "../derive";

/** Base chip. Variants map to CSS classes: r, d, i, yea, nay, sold, owner, ocr, unverified, conflict, stale, t1, t2, neutral. */
export function chip(text: string, variant = "neutral", title?: string): HTMLSpanElement {
  const attrs: Record<string, string> = { class: `chip ${variant}` };
  if (title !== undefined) attrs["title"] = title;
  return el("span", attrs, text);
}

/** "R–TX" party chip, crimson/cobalt reserved for exactly this. */
export function partyChip(member: Pick<Member, "party" | "state">): HTMLSpanElement {
  return chip(`${member.party}–${member.state}`, member.party.toLowerCase());
}

/** CLARITY floor-vote chip. Senators show the honest "no floor vote yet". */
export function voteChip(status: VoteStatus): HTMLSpanElement {
  switch (status.kind) {
    case "recorded": {
      const label =
        status.vote === "yea"
          ? "Yea"
          : status.vote === "nay"
            ? "Nay"
            : status.vote === "present"
              ? "Present"
              : "Not voting";
      const variant = status.vote === "yea" ? "yea" : status.vote === "nay" ? "nay" : "neutral";
      return chip(label, variant, "House passage vote on H.R. 3633");
    }
    case "senate-pending":
      return chip("no floor vote yet", "neutral", "The Senate has not voted on H.R. 3633");
    case "unrecorded":
      return chip("no roll-call data", "neutral", "Per-member roll-call data not ingested yet");
  }
}

/**
 * Every flag a holding row must carry: owner attribution when not the member
 * themself, OCR extraction, unverified / conflicting verification, and
 * stale / SOLD status with the filing date. Pass `{ owner: false }` where the
 * table already shows the owner in its own column (member portfolio view).
 */
export function holdingFlagChips(
  holding: Holding | PortfolioPosition,
  opts: { owner?: boolean } = {},
): HTMLSpanElement[] {
  const chips: HTMLSpanElement[] = [];
  if (holding.owner !== "self" && opts.owner !== false) {
    chips.push(chip(holding.owner, "owner", `Held by ${holding.owner}, attributed to the member`));
  }
  if (holding.extraction === "pdf-ocr") {
    chips.push(chip("OCR", "ocr", "Extracted from a scanned filing via OCR — read the filing"));
  }
  if (holding.verification === "unverified") {
    chips.push(chip("unverified", "unverified", "Not yet corroborated by independent reporting"));
  }
  if (holding.verification === "conflict") {
    chips.push(chip("conflicting sources", "conflict", "Sources disagree — read the filing"));
  }
  if (holding.status === "stale") {
    chips.push(
      chip(
        `stale · ${fmtMonthYear(holding.asOf)}`,
        "stale",
        "Last confirmed on an older filing; needs re-verification",
      ),
    );
  }
  if (holding.status === "sold") {
    chips.push(
      chip(`SOLD ${fmtMonthYear(holding.asOf)}`, "sold", "Disclosed sale — not a current holder"),
    );
  }
  return chips;
}
