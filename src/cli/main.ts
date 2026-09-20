#!/usr/bin/env bun
import path from "node:path";
import { migrateUp } from "../api/up.js";
import { migrateDown, parseSteps } from "../api/down.js";
import { migrateRedo } from "../api/redo.js";
import { migrateStatus } from "../api/status.js";
import { installMigrations } from "../api/install.js";
import { createMigrationCommand, type MigrationLang } from "../api/create.js";
import { initMigrations } from "../api/init.js";
import { markMigrationsApplied } from "../api/mark.js";
import { resolveSecondsOption } from "../core/duration.js";
import {
  ChecksumDriftError,
  DatabaseWaitTimeoutError,
  MigrationLockError,
  MigrationNotFoundError,
} from "../api/options.js";
import { InvalidIdentifierError } from "../core/identifiers.js";
import { log } from "../core/console.js";

interface CliArgs {
  command: string | undefined;
  positional: string[];
  url?: string | undefined;
  dir?: string | undefined;
  git: boolean;
  lang?: MigrationLang | undefined;
  to?: string | undefined;
  lockTimeout?: number | undefined;
  wait?: number | undefined;
  table?: string | undefined;
  schema?: string | undefined;
  dryRun: boolean;
  all: boolean;
  strict: boolean;
  help: boolean;
  version: boolean;
}

type FlagKey = Exclude<keyof CliArgs, "command" | "positional" | "help" | "version">;

const FLAG_NAMES: Record<FlagKey, string> = {
  url: "--url",
  dir: "--dir",
  git: "--git",
  lang: "--lang",
  to: "--to",
  lockTimeout: "--lock-timeout",
  wait: "--wait",
  table: "--table",
  schema: "--schema",
  dryRun: "--dry-run",
  all: "--all",
  strict: "--strict",
};

interface CommandSpec {
  flags: ReadonlySet<FlagKey>;
  positionalLimit: number;
}

const COMMAND_SPECS: Record<string, CommandSpec> = {
  version: { flags: new Set<FlagKey>([]), positionalLimit: 0 },
  up: {
    flags: new Set(["url", "dir", "to", "lockTimeout", "wait", "table", "schema", "dryRun"]),
    positionalLimit: 0,
  },
  down: {
    flags: new Set(["url", "dir", "to", "wait", "table", "schema", "dryRun", "all"]),
    positionalLimit: 1,
  },
  redo: {
    flags: new Set(["url", "dir", "to", "lockTimeout", "wait", "table", "schema"]),
    positionalLimit: 1,
  },
  init: { flags: new Set(["dir", "lang"]), positionalLimit: 0 },
  install: { flags: new Set(["url", "dir", "wait", "table", "schema"]), positionalLimit: 0 },
  create: { flags: new Set(["dir", "lang", "git"]), positionalLimit: 1 },
  mark: { flags: new Set(["url", "dir", "wait", "table", "schema", "all"]), positionalLimit: 1 },
  status: {
    flags: new Set(["url", "dir", "wait", "table", "schema", "strict"]),
    positionalLimit: 0,
  },
};

function rejectDisallowedFlags(command: string, args: CliArgs): void {
  const spec = COMMAND_SPECS[command];
  if (spec === undefined) {
    return;
  }
  const [extra] = args.positional.slice(spec.positionalLimit);
  if (extra !== undefined) {
    log({ text: `Unexpected argument for ${command}: ${extra}`, type: "error" });
    usage(1);
  }
  for (const flag of Object.keys(FLAG_NAMES) as FlagKey[]) {
    const value = args[flag];
    if (value === undefined || value === false || spec.flags.has(flag)) {
      continue;
    }
    log({ text: `${command} does not support ${FLAG_NAMES[flag]}.`, type: "error" });
    usage(1);
  }
}

function parseSecondsValue(flag: string, value: string | undefined): number {
  try {
    return resolveSecondsOption(flag, Number(value), 0);
  } catch {
    log({
      text: `Invalid ${flag}: ${value ?? "(missing)"} (expected a non-negative integer of seconds)`,
      type: "error",
    });
    usage(1);
  }
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let url: string | undefined;
  let dir: string | undefined;
  let git = false;
  let lang: MigrationLang | undefined;
  let to: string | undefined;
  let lockTimeout: number | undefined;
  let wait: number | undefined;
  let table: string | undefined;
  let schema: string | undefined;
  let dryRun = false;
  let all = false;
  let strict = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--url") {
      url = argv[++i];
      if (url === undefined) {
        log({ text: "--url requires a database URL", type: "error" });
        usage(1);
      }
    } else if (arg === "--dir") {
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
      lockTimeout = parseSecondsValue("--lock-timeout", argv[++i]);
    } else if (arg === "--wait") {
      wait = parseSecondsValue("--wait", argv[++i]);
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
    } else if (arg === "--version") {
      version = true;
    } else {
      positional.push(arg);
    }
  }
  return {
    command: positional.shift(),
    positional,
    url,
    dir,
    git,
    lang,
    to,
    lockTimeout,
    wait,
    table,
    schema,
    dryRun,
    all,
    strict,
    help,
    version,
  };
}

function usage(exitCode: number): never {
  log({
    text: "Usage: bunsql-native-migrate <init|up|down [n]|redo [n]|install|create [name]|mark [name]|status|version> [--url <url>] [--dir <migrations-dir>] [--to <name>] [--lock-timeout <seconds>] [--wait <seconds>] [--table <name>] [--schema <name>] [--dry-run] [--all] [--lang <js|ts>] [--git] [--strict] [--version] [--help]",
    type: "info",
  });
  process.exit(exitCode);
}

async function printVersion(): Promise<void> {
  const manifest = await Bun.file(path.resolve(import.meta.dir, "..", "..", "package.json")).json();
  log({ text: String(manifest.version), type: "info" });
}

const args = parseArgs(process.argv.slice(2));
const urlOptions = args.url !== undefined ? { databaseUrl: args.url } : {};
const waitOptions = args.wait !== undefined && args.wait > 0 ? { waitTimeout: args.wait } : {};
const listDirOptions = args.dir ? { listDir: args.dir } : {};
const tableOptions = {
  ...(args.table !== undefined ? { tableName: args.table } : {}),
  ...(args.schema !== undefined ? { schema: args.schema } : {}),
};
const connectOptions = {
  ...urlOptions,
  ...listDirOptions,
  ...tableOptions,
  ...waitOptions,
};

if (args.help) {
  usage(0);
}

if (args.version) {
  await printVersion();
  process.exit(0);
}

try {
  if (args.command !== undefined) {
    rejectDisallowedFlags(args.command, args);
  }
  switch (args.command) {
    case "version": {
      await printVersion();
      break;
    }
    case "up": {
      const { applied, planned } = await migrateUp({
        ...connectOptions,
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
      if (args.to !== undefined && (args.all || stepsArg !== undefined)) {
        log({
          text: "Use either --to, --all, or a number of steps, not more than one of them.",
          type: "error",
        });
        usage(1);
      }
      let steps: number | "all" = 1;
      if (args.all) {
        steps = "all";
      } else if (stepsArg !== undefined) {
        try {
          steps = parseSteps(Number(stepsArg));
        } catch {
          log({
            text: `Invalid step count: ${stepsArg} (expected a positive integer)`,
            type: "error",
          });
          usage(1);
        }
      }
      const { reverted, planned } = await migrateDown({
        ...connectOptions,
        ...(args.to !== undefined ? { to: args.to } : { steps }),
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
    case "redo": {
      const [stepsArg] = args.positional;
      if (stepsArg !== undefined && args.to !== undefined) {
        log({ text: "Use either --to or a step count, not both.", type: "error" });
        usage(1);
      }
      let steps: number | undefined;
      if (stepsArg !== undefined) {
        try {
          steps = parseSteps(Number(stepsArg));
        } catch {
          log({
            text: `Invalid step count: ${stepsArg} (expected a positive integer)`,
            type: "error",
          });
          usage(1);
        }
      }
      const { reverted } = await migrateRedo({
        ...connectOptions,
        ...(steps !== undefined ? { steps } : {}),
        ...(args.to !== undefined ? { to: args.to } : {}),
        ...(args.lockTimeout !== undefined ? { lockTimeout: args.lockTimeout } : {}),
      });
      if (reverted.length > 0) {
        log({ text: `Redid ${reverted.length} migration(s).`, type: "success" });
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
      await installMigrations(connectOptions);
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
        ...connectOptions,
        ...(name !== undefined ? { to: name } : {}),
      });
      if (marked.length > 0) {
        log({ text: `Marked ${marked.length} migration(s) as applied.`, type: "success" });
      }
      break;
    }
    case "status": {
      const { applied, pending } = await migrateStatus(connectOptions);
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
    error instanceof DatabaseWaitTimeoutError ||
    error instanceof InvalidIdentifierError
  ) {
    log({ text: error.message, type: "error" });
  } else {
    log({ text: "Migration command failed", type: "error", error });
  }
  process.exit(1);
}
