#!/usr/bin/env bun
import { migrateUp } from "../api/up.js";
import { migrateDown } from "../api/down.js";
import { installMigrations } from "../api/install.js";
import { createMigrationCommand } from "../api/create.js";
import { ChecksumDriftError } from "../api/options.js";
import { log } from "../core/console.js";

interface CliArgs {
  command: string | undefined;
  positional: string[];
  dir?: string | undefined;
  git: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let dir: string | undefined;
  let git = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dir") {
      dir = argv[++i];
    } else if (arg === "--git") {
      git = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      positional.push(arg);
    }
  }
  return { command: positional.shift(), positional, dir, git, help };
}

function usage(exitCode: number): never {
  log({
    text: "Usage: bunsql-native-migrate <up|down|install|create [name]> [--dir <migrations-dir>] [--git] [--help]",
    type: "info",
  });
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
const listDirOptions = args.dir ? { listDir: args.dir } : {};

if (args.help) {
  usage(0);
}

try {
  switch (args.command) {
    case "up": {
      const { applied } = await migrateUp(listDirOptions);
      if (applied.length > 0) {
        log({ text: `Applied ${applied.length} migration(s).`, type: "success" });
      }
      break;
    }
    case "down": {
      await migrateDown(listDirOptions);
      break;
    }
    case "install": {
      await installMigrations(listDirOptions);
      break;
    }
    case "create": {
      const [name] = args.positional;
      await createMigrationCommand({
        ...(name ? { name } : {}),
        git: args.git,
        ...listDirOptions,
      });
      break;
    }
    default:
      usage(1);
  }
} catch (error) {
  if (error instanceof ChecksumDriftError) {
    log({ text: error.message, type: "error" });
  } else {
    log({ text: "Migration command failed", type: "error", error });
  }
  process.exit(1);
}
