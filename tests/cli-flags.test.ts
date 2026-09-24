import { describe, it, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { migrateUp } from "../src/index.js";
import {
  cliEnv,
  envWithoutDatabaseUrl,
  makeScenario,
  readRecords,
  readTables,
  runCli,
  writeTableMigration,
  type Scenario,
} from "./helpers.js";

function envFor(scenario: Scenario): Record<string, string> {
  return cliEnv({
    databaseUrl: scenario.options.databaseUrl,
    listDir: scenario.listDir,
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

      expect(redo.exitCode).toBe(5);
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

      expect(redo.exitCode).toBe(5);
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
      expect(strict.exitCode).toBe(5);
      expect(strict.output).toContain("up does not support --strict");

      const to = await runCli(["mark", "--to", "1_a.js"], envFor(scenario));
      expect(to.exitCode).toBe(5);
      expect(to.output).toContain("mark does not support --to");

      const all = await runCli(["status", "--all"], envFor(scenario));
      expect(all.exitCode).toBe(5);
      expect(all.output).toContain("status does not support --all");
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects unexpected positional arguments", async () => {
    const scenario = makeScenario("bunsql-flags-positional-", "db.sqlite");
    try {
      const run = await runCli(["up", "3"], envFor(scenario));

      expect(run.exitCode).toBe(5);
      expect(run.output).toContain("Unexpected argument for up: 3");
    } finally {
      scenario.cleanup();
    }
  });

  it("reports a disallowed flag before loading the project config", async () => {
    const scenario = makeScenario("bunsql-flags-config-order-", "db.sqlite");
    try {
      writeFileSync(
        path.join(scenario.dir, "bunsql-migrate.config.ts"),
        `export default { unknownKey: true };`,
      );

      const run = await runCli(["up", "--strict"], envFor(scenario), scenario.dir);

      expect(run.exitCode).toBe(5);
      expect(run.output).toContain("up does not support --strict");
      expect(run.output).not.toContain("unknownKey");
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects a flag-like value instead of swallowing the next flag", async () => {
    const scenario = makeScenario("bunsql-flags-swallows-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");
      writeTableMigration(scenario.listDir, "2_b.js", "b_table");
      await migrateUp(scenario.options);
      const before = readRecords(scenario.dbPath);

      const run = await runCli(["down", "--dir", "--dry-run", "2"], envFor(scenario));

      expect(run.exitCode).toBe(5);
      expect(run.output).toContain("--dir requires");
      expect(readRecords(scenario.dbPath)).toEqual(before);
    } finally {
      scenario.cleanup();
    }
  });

  it("requires a value for --dir when it is the last argument", async () => {
    const scenario = makeScenario("bunsql-flags-dir-missing-", "db.sqlite");
    try {
      const run = await runCli(["up", "--dir"], envFor(scenario));

      expect(run.exitCode).toBe(5);
      expect(run.output).toContain("--dir requires");
    } finally {
      scenario.cleanup();
    }
  });

  it("treats an empty --to as a usage error instead of applying everything", async () => {
    const scenario = makeScenario("bunsql-flags-empty-to-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");

      const run = await runCli(["up", "--to", ""], envFor(scenario));

      expect(run.exitCode).toBe(5);
      expect(run.output).toContain("--to requires");
      expect(readTables(scenario.dbPath)).not.toContain("a_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects empty positionals for create and mark", async () => {
    const scenario = makeScenario("bunsql-flags-empty-pos-", "db.sqlite");
    try {
      const create = await runCli(["create", ""], envFor(scenario));
      expect(create.exitCode).toBe(5);
      expect(create.output).not.toContain("Migration created");

      const mark = await runCli(["mark", ""], envFor(scenario));
      expect(mark.exitCode).toBe(5);
    } finally {
      scenario.cleanup();
    }
  });

  it("no longer accepts --dir for install", async () => {
    const scenario = makeScenario("bunsql-flags-install-dir-", "db.sqlite");
    try {
      const run = await runCli(["install", "--dir", scenario.listDir], envFor(scenario));

      expect(run.exitCode).toBe(5);
      expect(run.output).toContain("install does not support --dir");
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
