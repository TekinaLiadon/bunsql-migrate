#!/usr/bin/env bun
import { migrateUp } from "../api/up.js";
import { migrateDown } from "../api/down.js";
import { migrateStatus } from "../api/status.js";
import { installMigrations } from "../api/install.js";
import { createMigrationCommand, type MigrationLang } from "../api/create.js";
import { initMigrations } from "../api/init.js";
import { markMigrationsApplied } from "../api/mark.js";
import { ChecksumDriftError, MigrationLockError, MigrationNotFoundError } from "../api/options.js";
import { InvalidIdentifierError } from "../core/identifiers.js";
import { log } from "../core/console.js";

interface CliArgs {
  command: string | undefined;
  positional: string[];
  dir?: string | undefined;
  git: boolean;
  lang?: MigrationLang | undefined;
  to?: string | undefined;
  lockTimeout?: number | undefined;
  table?: string | undefined;
  schema?: string | undefined;
  dryRun: boolean;
  all: boolean;
  strict: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let dir: string | undefined;
  let git = false;
  let lang: MigrationLang | undefined;
  let to: string | undefined;
  let lockTimeout: number | undefined;
  let table: string | undefined;
  let schema: string | undefined;
  let dryRun = false;
  let all = false;
  let strict = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dir") {
      dir = argv[++i];
    } else if (arg === "--git") {
      git = true;
    } else if (arg === "--lang") {
      const value = argv[++i];
      if (value !== "js" && value !== "ts") {
        log({
          text: `Unknown --lang value: ${value ?? "(missing)"} (expected js or ts)`,
          type: "error",
        });
        usage(1);
      }
      lang = value;
    } else if (arg === "--to") {
      to = argv[++i];
      if (to === undefined) {
        log({ text: "--to requires a migration file name", type: "error" });
        usage(1);
      }
    } else if (arg === "--lock-timeout") {
      const value = argv[++i];
      const parsed = Number(value);
      if (value === undefined || !Number.isInteger(parsed) || parsed < 0) {
        log({
          text: `Invalid --lock-timeout: ${value ?? "(missing)"} (expected a non-negative integer of seconds)`,
          type: "error",
        });
        usage(1);
      }
      lockTimeout = parsed;
    } else if (arg === "--table") {
      table = argv[++i];
      if (table === undefined) {
        log({ text: "--table requires a tracking table name", type: "error" });
        usage(1);
      }
    } else if (arg === "--schema") {
      schema = argv[++i];
      if (schema === undefined) {
        log({ text: "--schema requires a postgres schema name", type: "error" });
        usage(1);
      }
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      positional.push(arg);
    }
  }
  return {
    command: positional.shift(),
    positional,
    dir,
    git,
    lang,
    to,
    lockTimeout,
    table,
    schema,
    dryRun,
    all,
    strict,
    help,
  };
}

function usage(exitCode: number): never {
  log({
    text: "Usage: bunsql-native-migrate <init|up|down [n]|install|create [name]|mark [name]|status> [--dir <migrations-dir>] [--to <name>] [--lock-timeout <seconds>] [--table <name>] [--schema <name>] [--dry-run] [--all] [--lang <js|ts>] [--git] [--strict] [--help]",
    type: "info",
  });
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
const listDirOptions = args.dir ? { listDir: args.dir } : {};
const tableOptions = {
  ...(args.table !== undefined ? { tableName: args.table } : {}),
  ...(args.schema !== undefined ? { schema: args.schema } : {}),
};

if (args.help) {
  usage(0);
}

try {
  switch (args.command) {
    case "up": {
      const { applied, planned } = await migrateUp({
        ...listDirOptions,
        ...tableOptions,
        ...(args.to ? { to: args.to } : {}),
        ...(args.lockTimeout !== undefined ? { lockTimeout: args.lockTimeout } : {}),
        ...(args.dryRun ? { dryRun: true } : {}),
      });
      if (planned !== undefined && planned.length > 0) {
        log({ text: `Would apply ${planned.length} migration(s).`, type: "info" });
      }
      if (applied.length > 0) {
        log({ text: `Applied ${applied.length} migration(s).`, type: "success" });
      }
      break;
    }
    case "down": {
      const [stepsArg] = args.positional;
      if (args.all && stepsArg !== undefined) {
        log({ text: "Use either --all or a number of steps, not both.", type: "error" });
        usage(1);
      }
      let steps: number | "all" = 1;
      if (args.all) {
        steps = "all";
      } else if (stepsArg !== undefined) {
        const parsed = Number(stepsArg);
        if (!Number.isInteger(parsed) || parsed < 1) {
          log({
            text: `Invalid step count: ${stepsArg} (expected a positive integer)`,
            type: "error",
          });
          usage(1);
        }
        steps = parsed;
      }
      const { reverted, planned } = await migrateDown({
        ...listDirOptions,
        ...tableOptions,
        steps,
        ...(args.dryRun ? { dryRun: true } : {}),
      });
      if (planned !== undefined && planned.length > 0) {
        log({ text: `Would revert ${planned.length} migration(s).`, type: "info" });
      }
      if (reverted.length > 0) {
        log({ text: `Reverted ${reverted.length} migration(s).`, type: "success" });
      }
      break;
    }
    case "init": {
      await initMigrations({
        ...listDirOptions,
        ...(args.lang !== undefined ? { lang: args.lang } : {}),
      });
      break;
    }
    case "install": {
      await installMigrations({ ...listDirOptions, ...tableOptions });
      break;
    }
    case "create": {
      const [name] = args.positional;
      await createMigrationCommand({
        ...(name ? { name } : {}),
        ...(args.lang ? { lang: args.lang } : {}),
        git: args.git,
        ...listDirOptions,
      });
      break;
    }
    case "mark": {
      const [name] = args.positional;
      if (args.all && name !== undefined) {
        log({ text: "Use either --all or a migration file name, not both.", type: "error" });
        usage(1);
      }
      if (!args.all && name === undefined) {
        log({ text: "mark requires a migration file name or --all.", type: "error" });
        usage(1);
      }
      const { marked } = await markMigrationsApplied({
        ...listDirOptions,
        ...tableOptions,
        ...(name !== undefined ? { to: name } : {}),
      });
      if (marked.length > 0) {
        log({ text: `Marked ${marked.length} migration(s) as applied.`, type: "success" });
      }
      break;
    }
    case "status": {
      const { applied, pending } = await migrateStatus({ ...listDirOptions, ...tableOptions });
      for (const entry of applied) {
        log({ text: `${entry.name} applied`, type: "info" });
      }
      for (const file of pending) {
        log({ text: `${file} pending`, type: "warn" });
      }
      log({ text: `${applied.length} applied, ${pending.length} pending`, type: "info" });
      if (args.strict && pending.length > 0) {
        log({ text: `Strict mode: ${pending.length} pending migration(s).`, type: "warn" });
        process.exit(1);
      }
      break;
    }
    default:
      usage(1);
  }
} catch (error) {
  if (
    error instanceof ChecksumDriftError ||
    error instanceof MigrationNotFoundError ||
    error instanceof MigrationLockError ||
    error instanceof InvalidIdentifierError
  ) {
    log({ text: error.message, type: "error" });
  } else {
    log({ text: "Migration command failed", type: "error", error });
  }
  process.exit(1);
}
