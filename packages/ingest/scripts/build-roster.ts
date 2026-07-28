/**
 * Build the full 119th-Congress member roster (data/members.json) from the
 * public-domain unitedstates/congress-legislators dataset.
 *
 *   npx tsx packages/ingest/scripts/build-roster.ts [--input file.json]
 *       [--members data/members.json] [--traders config/traders.json]
 *
 * Source: https://unitedstates.github.io/congress-legislators/legislators-current.json
 * (CC0). For each current legislator the script emits the shared Member shape
 * (bioguideId, lisId for senators, name, party, chamber, state, district,
 * active) and then overlays local knowledge:
 *
 *   - members already in data/members.json keep their curated name, active
 *     flag, and note (fixture flags survive regeneration);
 *   - members on the config/traders.json roster are marked
 *     traderRoster: "active" | "watch";
 *   - inactive members recorded locally but absent from the upstream dataset
 *     (e.g. MTG, resigned 2026-01-05) are re-appended so historical rows keep
 *     resolving;
 *   - if the upstream dataset still lists a locally-inactive member, the local
 *     inactive flag wins (with the local note explaining why).
 *
 * Sanity check: total voting members should be ~535 (vacancies allowed); the
 * dataset also carries the 6 non-voting delegates, who file FDs like everyone
 * else and stay on the roster.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseMembers, parseTradersConfig, type Member } from "@clarity-btc/shared";

const LEGISLATORS_CURRENT_URL =
  "https://unitedstates.github.io/congress-legislators/legislators-current.json";

/** Members that must never come back active regardless of the upstream feed. */
const FORCED_INACTIVE: Record<string, string> = {
  G000596:
    "Resigned from Congress effective 2026-01-05 (announced 2025-11-21). Historical data only.",
};

const NON_VOTING_STATES = new Set(["DC", "PR", "GU", "VI", "AS", "MP"]);

interface LegislatorTerm {
  type: "rep" | "sen";
  state: string;
  district?: number;
  party?: string;
  end: string;
}

interface Legislator {
  id: { bioguide: string; lis?: string };
  name: { official_full?: string; first: string; last: string };
  terms: LegislatorTerm[];
}

function parseArgs(argv: string[]): { input?: string; members: string; traders: string } {
  const args = { members: "data/members.json", traders: "config/traders.json" } as {
    input?: string;
    members: string;
    traders: string;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--input") args.input = value;
    else if (flag === "--members") args.members = value;
    else if (flag === "--traders") args.traders = value;
    else throw new Error(`unknown flag: ${flag}`);
    i++;
  }
  return args;
}

function toParty(party: string | undefined): Member["party"] {
  if (party === "Republican") return "R";
  if (party === "Democrat") return "D";
  if (party === "Independent") return "I";
  throw new Error(`unmapped party: ${party ?? "(none)"}`);
}

function toDistrict(term: LegislatorTerm): string {
  const n = term.district ?? 0;
  return n === 0 ? `${term.state}-AL` : `${term.state}-${String(n).padStart(2, "0")}`;
}

function fromLegislator(leg: Legislator): Member {
  const term = leg.terms[leg.terms.length - 1];
  if (term === undefined) throw new Error(`${leg.id.bioguide}: no terms`);
  const chamber = term.type === "sen" ? "senate" : "house";
  return {
    bioguideId: leg.id.bioguide,
    ...(chamber === "senate" && leg.id.lis !== undefined ? { lisId: leg.id.lis } : {}),
    name: leg.name.official_full ?? `${leg.name.first} ${leg.name.last}`,
    party: toParty(term.party),
    chamber,
    state: term.state,
    ...(chamber === "house" ? { district: toDistrict(term) } : {}),
    active: true,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const legislators: Legislator[] = args.input
    ? (JSON.parse(await readFile(args.input, "utf8")) as Legislator[])
    : ((await (await fetch(LEGISLATORS_CURRENT_URL)).json()) as Legislator[]);
  const existing = parseMembers(JSON.parse(await readFile(args.members, "utf8")));
  const traders = parseTradersConfig(JSON.parse(await readFile(args.traders, "utf8")));

  const existingById = new Map(existing.map((m) => [m.bioguideId, m]));
  const rosterMark = new Map<string, "active" | "watch">();
  for (const t of traders.active) rosterMark.set(t.id, "active");
  for (const t of traders.watch) if (!rosterMark.has(t.id)) rosterMark.set(t.id, "watch");

  const members: Member[] = [];
  for (const leg of legislators) {
    const fresh = fromLegislator(leg);
    const prior = existingById.get(fresh.bioguideId);
    const forced = FORCED_INACTIVE[fresh.bioguideId];
    const member: Member = {
      ...fresh,
      // Curated local knowledge survives regeneration.
      ...(prior !== undefined
        ? { name: prior.name, active: prior.active, ...(prior.note !== undefined ? { note: prior.note } : {}) }
        : {}),
      ...(forced !== undefined ? { active: false, note: forced } : {}),
    };
    const mark = rosterMark.get(member.bioguideId);
    if (mark !== undefined) member.traderRoster = mark;
    members.push(member);
  }

  // Locally-known members missing upstream (resigned/expelled): keep them,
  // inactive, so historical holdings/trades keep resolving to a member.
  const upstreamIds = new Set(members.map((m) => m.bioguideId));
  for (const prior of existing) {
    if (upstreamIds.has(prior.bioguideId)) continue;
    const forced = FORCED_INACTIVE[prior.bioguideId];
    members.push({
      ...prior,
      active: false,
      note:
        forced ??
        prior.note ??
        "Not in the current unitedstates/congress-legislators dataset - departed member kept for historical rows.",
      ...(rosterMark.has(prior.bioguideId)
        ? { traderRoster: rosterMark.get(prior.bioguideId) }
        : {}),
    });
  }

  members.sort((a, b) => {
    if (a.chamber !== b.chamber) return a.chamber === "senate" ? -1 : 1;
    if (a.state !== b.state) return a.state < b.state ? -1 : 1;
    const ad = a.district ?? "";
    const bd = b.district ?? "";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  // Validate the payload round-trips through the shared contract.
  const payload = parseMembers(JSON.parse(JSON.stringify(members))).map((m, i) => {
    void m;
    return members[i];
  });
  await writeFile(args.members, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const active = members.filter((m) => m.active);
  const voting = active.filter(
    (m) => m.chamber === "senate" || !NON_VOTING_STATES.has(m.state),
  );
  const senate = active.filter((m) => m.chamber === "senate").length;
  console.log(
    `wrote ${members.length} members to ${args.members} ` +
      `(${active.length} active: ${senate} senators, ${active.length - senate} house; ` +
      `${voting.length} voting members, expect ~535 minus vacancies)`,
  );
  if (voting.length < 520 || voting.length > 540) {
    throw new Error(`voting member count ${voting.length} is out of the expected range`);
  }
  const mtg = members.find((m) => m.bioguideId === "G000596");
  if (mtg !== undefined && mtg.active) {
    throw new Error("MTG (G000596) must be inactive (resigned 2026-01-05)");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
