import { describe, it, expect } from "bun:test";
import { migrateUp } from "../src/index.js";
import {
  cliEnv,
  makeScenario,
  readRecords,
  readTables,
  runCli,
  writeTableMigration,
  type Scenario,
} from "./helpers.js";

function decoyEnv(decoy: Scenario, listDir: string): Record<string, string> {
  return cliEnv({
    databaseUrl: decoy.options.databaseUrl,
    listDir,
  });
}

describe("CLI --url", () => {
  it("overrides DATABASE_URL from the environment for up", async () => {
    const decoy = makeScenario("bunsql-url-decoy-", "decoy.sqlite");
    const target = makeScenario("bunsql-url-target-", "target.sqlite");
    try {
      writeTableMigration(target.listDir, "2_b.js", "b_table");
      writeTableMigration(target.listDir, "1_a.js", "a_table");

      const up = await runCli(
        ["up", "--url", target.options.databaseUrl],
        decoyEnv(decoy, target.listDir),
      );

      expect(up.exitCode).toBe(0);
      expect(readRecords(target.dbPath).map((record) => record.migration)).toEqual([
        "2_b.js",
        "1_a.js",
      ]);
      expect(readTables(decoy.dbPath)).toHaveLength(0);
    } finally {
      decoy.cleanup();
      target.cleanup();
    }
  });

  it("applies to status, install, down, mark and redo", async () => {
    const decoy = makeScenario("bunsql-url-decoy-", "decoy.sqlite");
    try {
      const status = makeScenario("bunsql-url-status-", "status.sqlite");
      const install = makeScenario("bunsql-url-install-", "install.sqlite");
      const down = makeScenario("bunsql-url-down-", "down.sqlite");
      const mark = makeScenario("bunsql-url-mark-", "mark.sqlite");
      const redo = makeScenario("bunsql-url-redo-", "redo.sqlite");
      try {
        writeTableMigration(status.listDir, "1_s.js", "s_table");
        await migrateUp(status.options);
        const statusRun = await runCli(
          ["status", "--url", status.options.databaseUrl],
          decoyEnv(decoy, status.listDir),
        );
        expect(statusRun.exitCode).toBe(0);
        expect(statusRun.output).toContain("1 applied, 0 pending");

        writeTableMigration(install.listDir, "1_i.js", "i_table");
        const installRun = await runCli(
          ["install", "--url", install.options.databaseUrl],
          decoyEnv(decoy, install.listDir),
        );
        expect(installRun.exitCode).toBe(0);
        expect(readTables(install.dbPath)).toContain("migrations");

        writeTableMigration(down.listDir, "2_d.js", "d2_table");
        writeTableMigration(down.listDir, "1_d.js", "d1_table");
        await migrateUp(down.options);
        const downRun = await runCli(
          ["down", "--url", down.options.databaseUrl],
          decoyEnv(decoy, down.listDir),
        );
        expect(downRun.exitCode).toBe(0);
        expect(readRecords(down.dbPath).map((record) => record.migration)).toEqual(["2_d.js"]);

        writeTableMigration(mark.listDir, "1_m.js", "m_table");
        const markRun = await runCli(
          ["mark", "--all", "--url", mark.options.databaseUrl],
          decoyEnv(decoy, mark.listDir),
        );
        expect(markRun.exitCode).toBe(0);
        expect(readRecords(mark.dbPath).map((record) => record.migration)).toEqual(["1_m.js"]);

        writeTableMigration(redo.listDir, "1_r.js", "r_table");
        await migrateUp(redo.options);
        const redoRun = await runCli(
          ["redo", "--url", redo.options.databaseUrl],
          decoyEnv(decoy, redo.listDir),
        );
        expect(redoRun.exitCode).toBe(0);
        expect(redoRun.output).toContain("Redid 1 migration(s).");
      } finally {
        status.cleanup();
        install.cleanup();
        down.cleanup();
        mark.cleanup();
        redo.cleanup();
      }
      expect(readTables(decoy.dbPath)).toHaveLength(0);
    } finally {
      decoy.cleanup();
    }
  });

  it("exits 1 with the DATABASE_URL message when neither the flag nor env is set", async () => {
    const scenario = makeScenario("bunsql-url-missing-", "missing.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");

      const status = await runCli(["status"], cliEnv());

      expect(status.exitCode).toBe(1);
      expect(status.output).toContain("DATABASE_URL is not set");
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects a --url without a value", async () => {
    const scenario = makeScenario("bunsql-url-empty-", "empty.sqlite");
    try {
      const status = await runCli(["status", "--url"], cliEnv({ listDir: scenario.listDir }));

      expect(status.exitCode).toBe(5);
      expect(status.output).toContain("--url requires a database URL");
    } finally {
      scenario.cleanup();
    }
  });
});
