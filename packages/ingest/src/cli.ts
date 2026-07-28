/**
 * Pipeline CLI (build ticket 11). Run from the repo root:
 *
 *   npm run pipeline                    # live daily run (network, EXA_API_KEY)
 *   npm run pipeline -- --dry-run       # fixture-backed e2e, ZERO network,
 *                                       # writes into a scratch copy of data/
 *
 * Flags: --data-dir, --cache-dir, --state-dir, --config-dir, --exa-budget N,
 * --dry-run (also accepted as --dryRun). Exits non-zero on any failure; the
 * machine-readable failure report lands in <state-dir>/failure-report.json.
 */
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPipeline, type RunPipelineOptions } from "./pipeline.js";
import { createDryRunIO, DRY_RUN_EXPECTATIONS_PATH, seedDryRunState } from "./dryrun.js";

interface CliArgs {
  dataDir: string;
  cacheDir: string;
  stateDir: string;
  configDir: string;
  dryRun: boolean;
  exaBudget?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dataDir: "data",
    cacheDir: ".cache",
    stateDir: "state",
    configDir: "config",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inlineValue] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    const value = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (next === undefined) throw new Error(`missing value for ${flag}`);
      return next;
    };
    switch (flag) {
      case "--dry-run":
      case "--dryRun":
        args.dryRun = true;
        break;
      case "--data-dir":
        args.dataDir = value();
        break;
      case "--cache-dir":
        args.cacheDir = value();
        break;
      case "--state-dir":
        args.stateDir = value();
        break;
      case "--config-dir":
        args.configDir = value();
        break;
      case "--exa-budget":
        args.exaBudget = Number(value());
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string): void => console.log(`[pipeline] ${line}`);

  const options: RunPipelineOptions = {
    dataDir: args.dataDir,
    cacheDir: args.cacheDir,
    stateDir: args.stateDir,
    configDir: args.configDir,
    dryRun: args.dryRun,
    ...(args.exaBudget !== undefined ? { exaQueryBudget: args.exaBudget } : {}),
    log,
  };

  if (args.dryRun) {
    // Fixture-backed end-to-end pass, zero network. Outputs go to a scratch
    // copy of data/ so the working tree stays clean; the real config is used
    // except for the validation pins, which come from the fixture-world file.
    const scratch = await mkdtemp(path.join(tmpdir(), "clarity-btc-dryrun-"));
    const scratchData = path.join(scratch, "data");
    await cp(args.dataDir, scratchData, { recursive: true });
    options.dataDir = scratchData;
    options.cacheDir = path.join(scratch, "cache");
    options.stateDir = path.join(scratch, "state");
    options.expectationsPath = DRY_RUN_EXPECTATIONS_PATH;
    options.io = await createDryRunIO();
    await seedDryRunState(options.stateDir);
    log(`dry run: fixture IO, scratch workspace ${scratch}`);
  }

  const result = await runPipeline(options);

  log(`stats: ${JSON.stringify(result.stats)}`);
  for (const warning of result.warnings) log(`warning: ${warning}`);
  if (result.ok) {
    log(`OK - wrote ${result.wroteFiles.length} data files`);
  } else {
    log(`FAILED at ${result.failure?.step}: ${result.failure?.message}`);
    log(`failure report: ${result.failureReportPath}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`[pipeline] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
});
