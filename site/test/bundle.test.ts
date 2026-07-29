/**
 * Bundle budget (spec §v1.1): the main bundle must NOT import the 16MB
 * data/trades.json — portfolio data is fetched lazily. Runs a real
 * `vite build` and asserts the emitted JS+CSS stay under 700KB uncompressed.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(siteDir, "..");

const BUDGET_BYTES = 700 * 1024;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

describe("bundle budget", () => {
  it(
    "vite build emits < 700KB of JS+CSS uncompressed",
    () => {
      const viteBin = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");
      execFileSync(process.execPath, [viteBin, "build", siteDir], {
        cwd: repoRoot,
        stdio: "pipe",
      });

      const dist = path.join(siteDir, "dist");
      const emitted = walk(dist).filter((f) => f.endsWith(".js") || f.endsWith(".css"));
      expect(emitted.length).toBeGreaterThan(0);

      const total = emitted.reduce((sum, f) => sum + statSync(f).size, 0);
      const listing = emitted
        .map((f) => `${path.relative(dist, f)}: ${(statSync(f).size / 1024).toFixed(1)}KB`)
        .join(", ");
      expect(total, `emitted JS+CSS = ${(total / 1024).toFixed(1)}KB (${listing})`).toBeLessThan(
        BUDGET_BYTES,
      );
    },
    240_000,
  );
});
