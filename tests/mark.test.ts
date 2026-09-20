import { describe, it, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  markMigrationsApplied,
  migrateUp,
  migrateStatus,
  MigrationNotFoundError,
} from "../src/index.js";
import { checksumFile } from "../src/core/fs.js";
import { makeScenario, readRecords, readTables, runCli } from "./helpers.js";

function writeTxMigration(listDir: string, file: string, table: string): void {
  writeFileSync(
    path.join(listDir, file),
    `const up = async (tx) => {
  await tx\`CREATE TABLE ${table} (id INTEGER)\`;
};
const down = async (tx) => {
  await tx\`DROP TABLE ${table}\`;
};
export { up, down };
`,
  );
}

describe("markMigrationsApplied()", () => {
  it("marks every pending migration with actual checksums without running them", async () => {
    const scenario = makeScenario("bunsql-mark-", "db.sqlite");
    try {
      writeTxMigration(scenario.listDir, "3_c.js", "c_table");
      writeTxMigration(scenario.listDir, "2_b.js", "b_table");
      writeTxMigration(scenario.listDir, "1_a.js", "a_table");

      const { marked } = await markMigrationsApplied(scenario.options);

      expect(marked).toEqual(["3_c.js", "2_b.js", "1_a.js"]);
      expect(readTables(scenario.dbPath)).not.toContain("c_table");
      expect(readTables(scenario.dbPath)).not.toContain("b_table");
      expect(readTables(scenario.dbPath)).not.toContain("a_table");

      const records = readRecords(scenario.dbPath);
      expect(records.map((record) => record.migration)).toEqual(["3_c.js", "2_b.js", "1_a.js"]);
      for (const record of records) {
        expect(record.checksum).toMatch(/^[0-9a-f]{64}$/);
        expect(record.checksum).toBe(
          await checksumFile(path.join(scenario.listDir, record.migration)),
        );
      }
    } finally {
      scenario.cleanup();
    }
  });

  it("leaves a following up a no-op without checksum drift", async () => {
    const scenario = makeScenario("bunsql-mark-", "db.sqlite");
    try {
      writeTxMigration(scenario.listDir, "2_b.js", "b_table");
      writeTxMigration(scenario.listDir, "1_a.js", "a_table");
      await markMigrationsApplied(scenario.options);

      const up = await migrateUp(scenario.options);
      const status = await migrateStatus(scenario.options);

      expect(up.applied).toEqual([]);
      expect(status.pending).toEqual([]);
      expect(status.applied).toHaveLength(2);
      expect(readTables(scenario.dbPath)).not.toContain("b_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("marks up to and including the target, leaving the rest pending", async () => {
    const scenario = makeScenario("bunsql-mark-", "db.sqlite");
    try {
      writeTxMigration(scenario.listDir, "3_c.js", "c_table");
      writeTxMigration(scenario.listDir, "2_b.js", "b_table");
      writeTxMigration(scenario.listDir, "1_a.js", "a_table");

      const { marked } = await markMigrationsApplied({ ...scenario.options, to: "2_b.js" });

      expect(marked).toEqual(["3_c.js", "2_b.js"]);
      const status = await migrateStatus(scenario.options);
      expect(status.applied.map((entry) => entry.name)).toEqual(["3_c.js", "2_b.js"]);
      expect(status.pending).toEqual(["1_a.js"]);

      const up = await migrateUp(scenario.options);
      expect(up.applied).toEqual(["1_a.js"]);
      expect(readTables(scenario.dbPath)).toContain("a_table");
      expect(readTables(scenario.dbPath)).not.toContain("b_table");
      expect(readTables(scenario.dbPath)).not.toContain("c_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("is a no-op when the target is already applied", async () => {
    const scenario = makeScenario("bunsql-mark-", "db.sqlite");
    try {
      writeTxMigration(scenario.listDir, "2_b.js", "b_table");
      writeTxMigration(scenario.listDir, "1_a.js", "a_table");
      const first = await markMigrationsApplied({ ...scenario.options, to: "2_b.js" });
      expect(first.marked).toEqual(["2_b.js"]);

      const again = await markMigrationsApplied({ ...scenario.options, to: "2_b.js" });

      expect(again.marked).toEqual([]);
      expect(readRecords(scenario.dbPath).map((record) => record.migration)).toEqual(["2_b.js"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("marks nothing on a repeated run over the same history", async () => {
    const scenario = makeScenario("bunsql-mark-", "db.sqlite");
    try {
      writeTxMigration(scenario.listDir, "1_a.js", "a_table");
      await markMigrationsApplied(scenario.options);

      const again = await markMigrationsApplied(scenario.options);

      expect(again.marked).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("throws MigrationNotFoundError for an unknown target without recording anything", async () => {
    const scenario = makeScenario("bunsql-mark-", "db.sqlite");
    try {
      writeTxMigration(scenario.listDir, "1_a.js", "a_table");

      await expect(
        markMigrationsApplied({ ...scenario.options, to: "missing.js" }),
      ).rejects.toBeInstanceOf(MigrationNotFoundError);
      expect(readRecords(scenario.dbPath)).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });
});

describe("mark CLI", () => {
  it("mark <file> marks up to and including the file", async () => {
    const scenario = makeScenario("bunsql-mark-", "db.sqlite");
    try {
      writeTxMigration(scenario.listDir, "3_c.js", "c_table");
      writeTxMigration(scenario.listDir, "2_b.js", "b_table");
      writeTxMigration(scenario.listDir, "1_a.js", "a_table");
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };

      const mark = await runCli(["mark", "2_b.js"], env);
      expect(mark.exitCode).toBe(0);
      expect(mark.output).toContain("3_c.js marked as applied");
      expect(mark.output).toContain("2_b.js marked as applied");
      expect(mark.output).toContain("Marked 2 migration(s) as applied.");
      expect(readTables(scenario.dbPath)).not.toContain("c_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("mark --all marks every pending migration", async () => {
    const scenario = makeScenario("bunsql-mark-", "db.sqlite");
    try {
      writeTxMigration(scenario.listDir, "2_b.js", "b_table");
      writeTxMigration(scenario.listDir, "1_a.js", "a_table");
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };

      const mark = await runCli(["mark", "--all"], env);
      expect(mark.exitCode).toBe(0);
      expect(mark.output).toContain("Marked 2 migration(s) as applied.");
      expect(readRecords(scenario.dbPath).map((record) => record.migration)).toEqual([
        "2_b.js",
        "1_a.js",
      ]);
    } finally {
      scenario.cleanup();
    }
  });

  it("mark without arguments exits 1", async () => {
    const scenario = makeScenario("bunsql-mark-", "db.sqlite");
    try {
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };

      const mark = await runCli(["mark"], env);
      expect(mark.exitCode).toBe(1);
      expect(mark.output).toContain("mark requires a migration file name or --all");
    } finally {
      scenario.cleanup();
    }
  });

  it("mark rejects a file name combined with --all and an unknown target", async () => {
    const scenario = makeScenario("bunsql-mark-", "db.sqlite");
    try {
      writeTxMigration(scenario.listDir, "1_a.js", "a_table");
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };

      const both = await runCli(["mark", "1_a.js", "--all"], env);
      expect(both.exitCode).toBe(1);
      expect(both.output).toContain("not both");

      const unknown = await runCli(["mark", "missing.js"], env);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.output).toContain("missing.js is not in the migrations directory");
      expect(readRecords(scenario.dbPath)).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });
});
