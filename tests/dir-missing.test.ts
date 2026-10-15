import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listFiles,
  MigrationsDirectoryNotFoundError,
  MigrationsDirectoryNotADirectoryError,
} from "../src/core/fs.js";
import { migrateUp } from "../src/api/up.js";
import { migrateStatus } from "../src/api/status.js";
import { markMigrationsApplied } from "../src/api/mark.js";
import { migrateDown } from "../src/api/down.js";
import { migrateRedo } from "../src/api/redo.js";
import { initMigrations } from "../src/api/init.js";
import { cliEnv, runCli } from "./helpers.js";

interface MissingDirScenario {
  cwd: string;
  missingDir: string;
  options(dbFile: string): { databaseUrl: string; listDir: string };
  dbPath(dbFile: string): string;
  cleanup(): void;
}

function makeMissingDirScenario(prefix: string): MissingDirScenario {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const missingDir = path.join(dir, "no-such-migrations");
  return {
    cwd: dir,
    missingDir,
    options: (dbFile: string) => ({
      databaseUrl: `sqlite:${path.join(dir, dbFile)}`,
      listDir: missingDir,
    }),
    dbPath: (dbFile: string) => path.join(dir, dbFile),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function expectNoDatabaseFile(scenario: MissingDirScenario, dbFile: string): void {
  expect(existsSync(scenario.dbPath(dbFile))).toBe(false);
}

const CONNECTING_COMMANDS = [
  {
    label: "migrateUp",
    run: (options: { databaseUrl: string; listDir: string }) => migrateUp(options),
  },
  {
    label: "migrateStatus",
    run: (options: { databaseUrl: string; listDir: string }) => migrateStatus(options),
  },
  {
    label: "markMigrationsApplied",
    run: (options: { databaseUrl: string; listDir: string }) => markMigrationsApplied(options),
  },
  {
    label: "migrateDown",
    run: (options: { databaseUrl: string; listDir: string }) => migrateDown(options),
  },
  {
    label: "migrateRedo",
    run: (options: { databaseUrl: string; listDir: string }) => migrateRedo(options),
  },
] as const;

const CLI_COMMANDS = [
  { label: "up", args: ["up"] },
  { label: "status", args: ["status"] },
  { label: "mark --all", args: ["mark", "--all"] },
  { label: "down", args: ["down"] },
  { label: "redo", args: ["redo"] },
] as const;

describe("listFiles on a missing migrations directory", () => {
  it("throws MigrationsDirectoryNotFoundError with the path and a hint", async () => {
    const scenario = makeMissingDirScenario("bunsql-list-missing-");
    try {
      const error = await listFiles(scenario.missingDir).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(MigrationsDirectoryNotFoundError);
      expect((error as MigrationsDirectoryNotFoundError).directory).toBe(scenario.missingDir);
      expect((error as MigrationsDirectoryNotFoundError).message).toContain(scenario.missingDir);
      expect((error as MigrationsDirectoryNotFoundError).message).toContain("run init");
    } finally {
      scenario.cleanup();
    }
  });

  it("throws MigrationsDirectoryNotFoundError when the path is a regular file", async () => {
    const scenario = makeMissingDirScenario("bunsql-list-notdir-");
    try {
      const filePath = path.join(scenario.cwd, "not-a-dir.txt");
      writeFileSync(filePath, "not a directory");
      await expect(listFiles(filePath)).rejects.toThrow(MigrationsDirectoryNotFoundError);
    } finally {
      scenario.cleanup();
    }
  });
});

describe("API commands with a missing migrations directory", () => {
  for (const { label, run } of CONNECTING_COMMANDS) {
    it(`${label} rejects before connecting to the database`, async () => {
      const scenario = makeMissingDirScenario(`bunsql-${label.toLowerCase()}-missing-`);
      try {
        await expect(run(scenario.options(`${label.toLowerCase()}.db`))).rejects.toThrow(
          MigrationsDirectoryNotFoundError,
        );
        expectNoDatabaseFile(scenario, `${label.toLowerCase()}.db`);
      } finally {
        scenario.cleanup();
      }
    });
  }

  it("migrateUp reports the missing directory before an unknown to target", async () => {
    const scenario = makeMissingDirScenario("bunsql-up-to-missing-");
    try {
      await expect(
        migrateUp({ ...scenario.options("up-to.db"), to: "1_missing.ts" }),
      ).rejects.toThrow(MigrationsDirectoryNotFoundError);
      expectNoDatabaseFile(scenario, "up-to.db");
    } finally {
      scenario.cleanup();
    }
  });

  it("migrateUp dry run rejects the same way", async () => {
    const scenario = makeMissingDirScenario("bunsql-up-dry-missing-");
    try {
      await expect(migrateUp({ ...scenario.options("up-dry.db"), dryRun: true })).rejects.toThrow(
        MigrationsDirectoryNotFoundError,
      );
      expectNoDatabaseFile(scenario, "up-dry.db");
    } finally {
      scenario.cleanup();
    }
  });

  it("initMigrations still creates the directory when it is missing", async () => {
    const scenario = makeMissingDirScenario("bunsql-init-missing-");
    try {
      const listDir = path.join(scenario.cwd, "created-by-init");
      const result = await initMigrations({ listDir });
      expect(result.created).toBe(true);
      expect(existsSync(listDir)).toBe(true);
    } finally {
      scenario.cleanup();
    }
  });

  it("initMigrations reports a typed error when the path is taken by a file", async () => {
    const scenario = makeMissingDirScenario("bunsql-init-file-");
    try {
      const taken = path.join(scenario.cwd, "occupied");
      writeFileSync(taken, "a regular file");

      let caught: unknown;
      try {
        await initMigrations({ listDir: taken });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MigrationsDirectoryNotADirectoryError);
      expect((caught as MigrationsDirectoryNotADirectoryError).message).toContain(taken);
    } finally {
      scenario.cleanup();
    }
  });
});

describe("CLI commands with a missing migrations directory", () => {
  for (const { label, args } of CLI_COMMANDS) {
    it(`${label} exits 5 with the typed message instead of a raw error dump`, async () => {
      const scenario = makeMissingDirScenario(`bunsql-cli-${label.replaceAll(" ", "-")}-missing-`);
      const dbFile = `cli-${label.replaceAll(" ", "-")}.db`;
      try {
        const result = await runCli(
          [...args, "--dir", scenario.missingDir, "--url", `sqlite:${scenario.dbPath(dbFile)}`],
          cliEnv(),
          scenario.cwd,
        );
        expect(result.exitCode).toBe(5);
        expect(result.output).toContain("migrations directory not found");
        expect(result.output).toContain(scenario.missingDir);
        expect(result.output).not.toContain("Migration command failed");
        expectNoDatabaseFile(scenario, dbFile);
      } finally {
        scenario.cleanup();
      }
    });
  }

  it("create exits 5 with a typed message when the --dir path is taken by a file", async () => {
    const scenario = makeMissingDirScenario("bunsql-cli-create-taken-");
    try {
      const taken = path.join(scenario.cwd, "occupied");
      writeFileSync(taken, "a regular file");

      const result = await runCli(["create", "hello", "--dir", taken], cliEnv(), scenario.cwd);

      expect(result.exitCode).toBe(5);
      expect(result.output).toContain("migrations directory path is taken by a file");
      expect(result.output).toContain(taken);
      expect(result.output).not.toContain("Migration command failed");
    } finally {
      scenario.cleanup();
    }
  });
});
