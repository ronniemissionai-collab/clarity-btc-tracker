/**
 * Pipeline step 8: the validation gate.
 *
 * Checks the derived holdings against config/expectations.json:
 *   - Tier-1 holder count within holderBound (the bound comes from config -
 *     research ticket 04 pins 15-25 for the live world, but the gate takes
 *     whatever the loaded config says);
 *   - contested-case pins (McCormick BITB-not-direct, Gill direct-BTC range,
 *     Lummis blind-trust owner, MTG absent from the active holder set).
 *
 * Returns a typed ValidationReport {ok, failures[]}; the Action ticket wires
 * failure behavior (keep last good data, open a GitHub issue).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Expectations,
  Holding,
  Member,
  Security,
  UniverseConfig,
} from "@clarity-btc/shared";
import { parseExpectations } from "@clarity-btc/shared";
import { buildUniverseIndex } from "./universe.js";

type ContestedPin = Expectations["contested"][number];
type PinValues = NonNullable<ContestedPin["expect"]>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  code: "holder-count" | "contested-pin";
  /** Set for contested-pin failures: the pin id from config/expectations.json. */
  pinId?: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  /** Distinct active members with at least one non-sold Tier-1 holding. */
  tier1HolderCount: number;
  tier1Holders: string[];
  failures: ValidationFailure[];
}

export interface ValidateHoldingsOptions {
  holdings: Holding[];
  /** config/expectations.json (see loadExpectations). */
  expectations: Expectations;
  /** config/universe.json - maps securities to tiers. */
  universe: UniverseConfig | Security[];
  /** Member roster (data/members.json) - supplies the active flag. */
  members: Member[];
}

/** Load + validate config/expectations.json (default: relative to cwd). */
export async function loadExpectations(
  filePath: string = resolve("config", "expectations.json"),
): Promise<Expectations> {
  return parseExpectations(JSON.parse(await readFile(filePath, "utf8")));
}

// ---------------------------------------------------------------------------
// Pin helpers
// ---------------------------------------------------------------------------

function strValue(values: PinValues | undefined, key: string): string | null {
  const v = values?.[key];
  return typeof v === "string" ? v : null;
}

function numValue(values: PinValues | undefined, key: string): number | null {
  const v = values?.[key];
  return typeof v === "number" ? v : null;
}

/** Find the member's live (non-sold) holding matching a pin's ticker+kind. */
function findLive(live: Holding[], values: PinValues | undefined): Holding | undefined {
  const ticker = strValue(values, "ticker");
  const kind = strValue(values, "kind");
  if (ticker === null || kind === null) return undefined;
  return live.find((h) => h.security.ticker === ticker && h.security.kind === kind);
}

function describeRef(values: PinValues | undefined): string {
  return `${strValue(values, "ticker") ?? "?"}:${strValue(values, "kind") ?? "?"}`;
}

function checkPin(
  pin: ContestedPin,
  holdings: Holding[],
  members: Member[],
): ValidationFailure[] {
  const fail = (message: string): ValidationFailure => ({
    code: "contested-pin",
    pinId: pin.id,
    message: `[${pin.id}] ${pin.memberName}: ${message}`,
  });
  const live = holdings.filter((h) => h.memberId === pin.memberId && h.status !== "sold");

  switch (pin.rule) {
    case "holds-security": {
      const failures: ValidationFailure[] = [];
      if (pin.expect === undefined && pin.forbid === undefined) {
        return [fail("pin has neither expect nor forbid - config error")];
      }
      if (pin.expect !== undefined && findLive(live, pin.expect) === undefined) {
        failures.push(fail(`expected a live holding of ${describeRef(pin.expect)}, found none`));
      }
      if (pin.forbid !== undefined && findLive(live, pin.forbid) !== undefined) {
        failures.push(fail(`holds forbidden security ${describeRef(pin.forbid)}`));
      }
      return failures;
    }

    case "holding-range": {
      const lo = numValue(pin.expect, "lo");
      const hi = numValue(pin.expect, "hi");
      if (lo === null || hi === null) {
        return [fail("holding-range pin is missing numeric lo/hi bounds - config error")];
      }
      const holding = findLive(live, pin.expect);
      if (holding === undefined) {
        return [fail(`expected a live holding of ${describeRef(pin.expect)}, found none`)];
      }
      const overlaps = holding.range.lo <= hi && holding.range.hi >= lo;
      if (!overlaps) {
        return [
          fail(
            `derived range ${holding.range.lo}-${holding.range.hi} for ${describeRef(pin.expect)} does not overlap the pinned ${lo}-${hi}`,
          ),
        ];
      }
      return [];
    }

    case "owner": {
      const owner = strValue(pin.expect, "owner");
      if (owner === null) {
        return [fail("owner pin is missing the expected owner - config error")];
      }
      const holding = findLive(live, pin.expect);
      if (holding === undefined) {
        return [fail(`expected a live holding of ${describeRef(pin.expect)}, found none`)];
      }
      if (holding.owner !== owner) {
        return [
          fail(`${describeRef(pin.expect)} owner is "${holding.owner}", pinned as "${owner}"`),
        ];
      }
      return [];
    }

    case "member-inactive": {
      const roster = members.find((m) => m.bioguideId === pin.memberId);
      const rosterActive = roster === undefined ? false : roster.active;
      if (rosterActive) {
        const suffix = live.length > 0 ? ` and ${live.length} live holding(s)` : "";
        return [fail(`roster still marks the member active${suffix} - must be inactive`)];
      }
      // Inactive members may appear as historical data; they are excluded
      // from the active holder set by the count below.
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function validateHoldings(options: ValidateHoldingsOptions): ValidationReport {
  const { holdings, expectations, members } = options;
  const universe = buildUniverseIndex(options.universe);
  const failures: ValidationFailure[] = [];

  // Tier-1 holder count: distinct active members with a non-sold Tier-1 row.
  // Members absent from the roster count as active (unknown ≠ resigned).
  const activeById = new Map(members.map((m) => [m.bioguideId, m.active]));
  const tier1Holders = new Set<string>();
  for (const holding of holdings) {
    if (holding.status === "sold") continue;
    if (universe.tierOf(holding.security) !== 1) continue;
    if ((activeById.get(holding.memberId) ?? true) === false) continue;
    tier1Holders.add(holding.memberId);
  }

  const { min, max } = expectations.holderBound;
  if (tier1Holders.size < min) {
    failures.push({
      code: "holder-count",
      message: `Tier-1 holder count ${tier1Holders.size} is below the expected minimum ${min} - the pipeline is likely missing PTR-only holders`,
    });
  } else if (tier1Holders.size > max) {
    failures.push({
      code: "holder-count",
      message: `Tier-1 holder count ${tier1Holders.size} is above the expected maximum ${max} - suspect false positives (e.g. Block/SQ counted as BTC)`,
    });
  }

  for (const pin of expectations.contested) {
    failures.push(...checkPin(pin, holdings, members));
  }

  return {
    ok: failures.length === 0,
    tier1HolderCount: tier1Holders.size,
    tier1Holders: [...tier1Holders].sort(),
    failures,
  };
}
