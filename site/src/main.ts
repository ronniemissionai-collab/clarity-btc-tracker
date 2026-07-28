/**
 * Placeholder front-end: proves the shared-contract + fixture wiring end to
 * end. The real Variant D two-tab interface lands in the design-build ticket.
 */
import { parseMembers, type Member } from "@clarity-btc/shared";
import membersRaw from "../../data/members.json";

const members: Member[] = parseMembers(membersRaw);

const app = document.querySelector<HTMLDivElement>("#app");
if (app === null) {
  throw new Error("missing #app mount point");
}

const heading = document.createElement("h1");
heading.textContent = "clarity-btc-tracker";

const status = document.createElement("p");
status.textContent = `fixtures loaded: ${members.length} members`;

app.append(heading, status);
