import { describe, it, expect } from "bun:test";
import { migrateUp } from "../src/index.js";
import {
  envWithoutDatabaseUrl,
  makeScenario,
  readRecords,
  runCli,
  writeTableMigration,
  type Scenario,
} from "./helpers.js";

function envFor(scenario: Scenario): Record<string, string> {
  return envWithoutDatabaseUrl({
    DATABASE_URL: scenario.options.databaseUrl,
    MIGRATION_LIST_DIR: scenario.listDir,
  });
}

describe("CLI per-command flag validation", () => {
  it("rejects redo --all before any writes instead of redoing one step", async () => {
    const scenario = makeScenario("bunsql-flags-redo-all-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "2_b.js", "b_table");
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");
      await migrateUp(scenario.options);
      const before = readRecords(scenario.dbPath);

      const redo = await runCli(["redo", "--all"], envFor(scenario));

      expect(redo.exitCode).toBe(1);
      expect(redo.output).toContain("redo does not support --all");
      expect(readRecords(scenario.dbPath)).toEqual(before);
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects redo --dry-run instead of running a real redo", async () => {
    const scenario = makeScenario("bunsql-flags-redo-dry-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");
      await migrateUp(scenario.options);
      const before = readRecords(scenario.dbPath);

      const redo = await runCli(["redo", "--dry-run"], envFor(scenario));

      expect(redo.exitCode).toBe(1);
      expect(redo.output).toContain("redo does not support --dry-run");
      expect(readRecords(scenario.dbPath)).toEqual(before);
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects flags that belong to other commands", async () => {
    const scenario = makeScenario("bunsql-flags-cross-", "db.sqlite");
    try {
      const strict = await runCli(["up", "--strict"], envFor(scenario));
      expect(strict.exitCode).toBe(1);
      expect(strict.output).toContain("up does not support --strict");

      const to = await runCli(["mark", "--to", "1_a.js"], envFor(scenario));
      expect(to.exitCode).toBe(1);
      expect(to.output).toContain("mark does not support --to");

      const all = await runCli(["status", "--all"], envFor(scenario));
      expect(all.exitCode).toBe(1);
      expect(all.output).toContain("status does not support --all");
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects unexpected positional arguments", async () => {
    const scenario = makeScenario("bunsql-flags-positional-", "db.sqlite");
    try {
      const run = await runCli(["up", "3"], envFor(scenario));

      expect(run.exitCode).toBe(1);
      expect(run.output).toContain("Unexpected argument for up: 3");
    } finally {
      scenario.cleanup();
    }
  });

  it("still accepts the documented flags and lets --version win over the command", async () => {
    const scenario = makeScenario("bunsql-flags-allowed-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");
      await migrateUp(scenario.options);

      const version = await runCli(["redo", "--version"], envWithoutDatabaseUrl());
      expect(version.exitCode).toBe(0);

      const down = await runCli(["down", "--dry-run"], envFor(scenario));
      expect(down.exitCode).toBe(0);
      expect(down.output).toContain("Would revert 1 migration(s)");

      const redo = await runCli(["redo", "--lock-timeout", "5"], envFor(scenario));
      expect(redo.exitCode).toBe(0);
      expect(redo.output).toContain("Redid 1 migration(s)");
    } finally {
      scenario.cleanup();
    }
  });
});
