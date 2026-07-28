import { describe, expect, it } from "vitest";
import { buildMemberMatcher } from "../../src/kadoa/index.js";
import { loadMembers } from "./helpers.js";

/**
 * Kadoa publishes legal-ish names; the roster uses common names. These are the
 * exact filer_name strings observed in the live data.
 */
describe("buildMemberMatcher", () => {
  const matcher = buildMemberMatcher(loadMembers());

  it("matches exact names", () => {
    expect(matcher.match("Nancy Pelosi", "house")?.bioguideId).toBe("P000197");
    expect(matcher.match("Brandon Gill", "house")?.bioguideId).toBe("G000602");
    expect(matcher.match("Sheri Biggs", "house")?.bioguideId).toBe("B001325");
  });

  it("matches formal given names against roster nicknames", () => {
    expect(matcher.match("David H McCormick", "senate")?.bioguideId).toBe("M001244"); // Dave
    expect(matcher.match("Rohit Khanna", "house")?.bioguideId).toBe("K000389"); // Ro
    expect(matcher.match("Gilbert Cisneros", "house")?.bioguideId).toBe("C001123"); // Gil
    expect(matcher.match("Nicholas Begich III", "house")?.bioguideId).toBe("B001323"); // Nick
  });

  it("matches when the roster name is a middle name (Felix Barry Moore -> Barry Moore)", () => {
    expect(matcher.match("Felix Barry Moore", "house")?.bioguideId).toBe("M001212");
  });

  it("keeps the two Moores apart", () => {
    expect(matcher.match("Tim Moore", "house")?.bioguideId).toBe("M001245");
    expect(matcher.match("Felix Barry Moore", "house")?.bioguideId).toBe("M001212");
  });

  it("ignores middle initials and generational suffixes", () => {
    expect(matcher.match("Cynthia M Lummis", "senate")?.bioguideId).toBe("L000571");
    expect(matcher.match("Guy Reschenthaler", "house")?.bioguideId).toBe("R000610");
    expect(matcher.match("Marjorie Taylor Greene", "house")?.bioguideId).toBe("G000596");
  });

  it("rejects a chamber mismatch", () => {
    expect(matcher.match("Nancy Pelosi", "senate")).toBeUndefined();
    expect(matcher.match("David H McCormick", "house")).toBeUndefined();
  });

  it("matches without a chamber hint", () => {
    expect(matcher.match("Shri Thanedar")?.bioguideId).toBe("T000488");
  });

  it("returns undefined for filers off the roster", () => {
    expect(matcher.match("Sam T. Liccardo", "house")).toBeUndefined();
    expect(matcher.match("Alan Armstrong", "senate")).toBeUndefined();
    expect(matcher.match("Richard Dean McCormick", "house")).toBeUndefined();
  });
});
