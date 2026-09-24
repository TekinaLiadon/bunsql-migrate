import { describe, it, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { migrateRedo, migrateUp, migrateStatus, MigrationNotFoundError } from "../src/index.js";
import { checksumFile } from "../src/core/fs.js";
import {
  makeScenario,
  readRecords,
  readRowCount,
  readTables,
  runCli,
  writeTableMigration,
} from "./helpers.js";

function writeMigration(listDir: string, file: string, upBody: string, downBody: string): void {
  writeFileSync(
    path.join(listDir, file),
    `const up = async (tx) => {
  ${upBody}
};
const down = async (tx) => {
  ${downBody}
};
export { up, down };
`,
  );
}

describe("migrateRedo()", () => {
  it("reverts and re-applies the last applied migration, leaving equivalent state", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeMigration(
        scenario.listDir,
        "3_audit.js",
        "await tx`CREATE TABLE audit (id INTEGER)`;",
        "await tx`DROP TABLE audit`;",
      );
      writeTableMigration(scenario.listDir, "2_mid.js", "mid_table");
      writeMigration(
        scenario.listDir,
        "1_target.js",
        "await tx`INSERT INTO audit (id) VALUES (7)`;",
        "await tx`DELETE FROM audit`;",
      );
      await migrateUp(scenario.options);
      const before = readRecords(scenario.dbPath);

      const result = await migrateRedo(scenario.options);

      expect(result.reverted).toEqual(["1_target.js"]);
      expect(result.applied).toEqual(["1_target.js"]);
      expect(readRecords(scenario.dbPath)).toEqual(before);
      expect(readRowCount(scenario.dbPath, "audit")).toBe(1);
      expect(readTables(scenario.dbPath)).toContain("mid_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("reverts and re-applies the last n migrations with steps", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "3_a.js", "a_table");
      writeTableMigration(scenario.listDir, "2_b.js", "b_table");
      writeTableMigration(scenario.listDir, "1_c.js", "c_table");
      await migrateUp(scenario.options);

      const result = await migrateRedo({ ...scenario.options, steps: 2 });

      expect(result.reverted).toEqual(["1_c.js", "2_b.js"]);
      expect(result.applied).toEqual(["2_b.js", "1_c.js"]);
      expect(readRecords(scenario.dbPath).map((record) => record.migration)).toEqual([
        "3_a.js",
        "2_b.js",
        "1_c.js",
      ]);
      for (const table of ["a_table", "b_table", "c_table"]) {
        expect(readTables(scenario.dbPath)).toContain(table);
      }
    } finally {
      scenario.cleanup();
    }
  });

  it("validates steps as a positive integer before any writes", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");

      await expect(migrateRedo({ ...scenario.options, steps: 0 })).rejects.toThrow(/Invalid steps/);
      await expect(migrateRedo({ ...scenario.options, steps: -1 })).rejects.toThrow(
        /Invalid steps/,
      );
      await expect(migrateRedo({ ...scenario.options, steps: 1.5 })).rejects.toThrow(
        /Invalid steps/,
      );
      await expect(migrateRedo({ ...scenario.options, steps: 1, to: "1_a.js" })).rejects.toThrow(
        /cannot be combined/,
      );
      expect(readTables(scenario.dbPath)).toHaveLength(0);
    } finally {
      scenario.cleanup();
    }
  });

  it("reverts down to the --to target inclusive and re-applies exactly that window", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "3_c.js", "c_table");
      writeTableMigration(scenario.listDir, "2_b.js", "b_table");
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");
      writeTableMigration(scenario.listDir, "0_z.js", "z_table");
      await migrateUp({ ...scenario.options, to: "1_a.js" });

      const result = await migrateRedo({ ...scenario.options, to: "2_b.js" });

      expect(result.reverted).toEqual(["1_a.js", "2_b.js"]);
      expect(result.applied).toEqual(["2_b.js", "1_a.js"]);
      const status = await migrateStatus(scenario.options);
      expect(status.applied.map((entry) => entry.name)).toEqual(["3_c.js", "2_b.js", "1_a.js"]);
      expect(status.pending).toEqual(["0_z.js"]);
      expect(readTables(scenario.dbPath)).not.toContain("z_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("throws MigrationNotFoundError for an unknown target before any writes", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");

      await expect(migrateRedo({ ...scenario.options, to: "missing.js" })).rejects.toBeInstanceOf(
        MigrationNotFoundError,
      );
      expect(readTables(scenario.dbPath)).toHaveLength(0);
    } finally {
      scenario.cleanup();
    }
  });

  it("treats a target that is not applied as a reported no-op", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "2_b.js", "b_table");
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");
      await migrateUp({ ...scenario.options, to: "2_b.js" });

      const result = await migrateRedo({ ...scenario.options, to: "1_a.js" });

      expect(result).toEqual({ reverted: [], applied: [] });
      expect(readRecords(scenario.dbPath).map((record) => record.migration)).toEqual(["2_b.js"]);
      const status = await migrateStatus(scenario.options);
      expect(status.pending).toEqual(["1_a.js"]);
      expect(readTables(scenario.dbPath)).not.toContain("a_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("is a no-op with a message on a fresh database", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "3_a.js", "a_table");
      writeTableMigration(scenario.listDir, "2_b.js", "b_table");

      const result = await migrateRedo(scenario.options);

      expect(result).toEqual({ reverted: [], applied: [] });
      const status = await migrateStatus(scenario.options);
      expect(status.applied).toEqual([]);
      expect(status.pending).toEqual(["3_a.js", "2_b.js"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("propagates an up-phase failure and leaves the reverted state visible", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "2_base.js", "base_table");
      writeMigration(
        scenario.listDir,
        "1_broken.js",
        "await tx`CREATE TABLE broken_table (id INTEGER)`;",
        "await tx`SELECT 1`;",
      );
      await migrateUp(scenario.options);

      await expect(migrateRedo(scenario.options)).rejects.toThrow();

      expect(readRecords(scenario.dbPath).map((record) => record.migration)).toEqual(["2_base.js"]);
      expect(readTables(scenario.dbPath)).toContain("broken_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("re-applies an edited .sql migration with its new checksum instead of failing on drift", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeFileSync(
        path.join(scenario.listDir, "1_edited.up.sql"),
        "CREATE TABLE edited_one (id INTEGER);",
      );
      writeFileSync(path.join(scenario.listDir, "1_edited.down.sql"), "DROP TABLE edited_one;");
      await migrateUp(scenario.options);
      writeFileSync(
        path.join(scenario.listDir, "1_edited.up.sql"),
        "CREATE TABLE edited_two (id INTEGER);",
      );

      const result = await migrateRedo(scenario.options);

      expect(result.applied).toEqual(["1_edited.up.sql"]);
      expect(readTables(scenario.dbPath)).toContain("edited_two");
      expect(readTables(scenario.dbPath)).not.toContain("edited_one");
      const [record] = readRecords(scenario.dbPath);
      expect(record?.checksum).toBe(
        await checksumFile(path.join(scenario.listDir, "1_edited.up.sql")),
      );
    } finally {
      scenario.cleanup();
    }
  });
});

describe("redo CLI", () => {
  it("redoes the last migration and prints a summary", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "2_first.js", "first_table");
      writeTableMigration(scenario.listDir, "1_last.js", "last_table");
      await migrateUp(scenario.options);
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };

      const redo = await runCli(["redo"], env);

      expect(redo.exitCode).toBe(0);
      expect(redo.output).toContain("1_last.js rolled back");
      expect(redo.output).toContain("1_last.js migrated up");
      expect(redo.output).toContain("Redid 1 migration(s).");
      expect(readRecords(scenario.dbPath).map((record) => record.migration)).toEqual([
        "2_first.js",
        "1_last.js",
      ]);
    } finally {
      scenario.cleanup();
    }
  });

  it("re-applies an edited .js migration with its new body in a fresh process", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeMigration(
        scenario.listDir,
        "1_edited.js",
        "await tx`CREATE TABLE edited_one (id INTEGER)`;",
        "await tx`DROP TABLE edited_one`;",
      );
      await migrateUp(scenario.options);
      writeMigration(
        scenario.listDir,
        "1_edited.js",
        "await tx`CREATE TABLE edited_one (id INTEGER)`;\n  await tx`CREATE TABLE edited_two (id INTEGER)`;",
        "await tx`DROP TABLE edited_one`;",
      );
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };

      const redo = await runCli(["redo"], env);

      expect(redo.exitCode).toBe(0);
      expect(redo.output).toContain("Redid 1 migration(s).");
      expect(readTables(scenario.dbPath)).toContain("edited_two");
    } finally {
      scenario.cleanup();
    }
  });

  it("redoes the last n migrations with a step count", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "3_a.js", "a_table");
      writeTableMigration(scenario.listDir, "2_b.js", "b_table");
      writeTableMigration(scenario.listDir, "1_c.js", "c_table");
      await migrateUp(scenario.options);
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };

      const redo = await runCli(["redo", "2"], env);

      expect(redo.exitCode).toBe(0);
      expect(redo.output).toContain("Redid 2 migration(s).");
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects an invalid step count and a step count combined with --to", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };

      for (const stepsArg of ["0", "-1", "abc"]) {
        const redo = await runCli(["redo", stepsArg], env);
        expect(redo.exitCode).toBe(5);
        expect(redo.output).toContain("Invalid step count");
      }

      const combined = await runCli(["redo", "1", "--to", "1_a.js"], env);
      expect(combined.exitCode).toBe(5);
      expect(combined.output).toContain("not both");
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects an unknown --to target with exit code 1", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };

      const redo = await runCli(["redo", "--to", "missing.js"], env);

      expect(redo.exitCode).toBe(1);
      expect(redo.output).toContain("missing.js is not in the migrations directory");
    } finally {
      scenario.cleanup();
    }
  });

  it("exits 0 with a message on a fresh database and for an unapplied --to target", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "2_b.js", "b_table");
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };

      const fresh = await runCli(["redo"], env);
      expect(fresh.exitCode).toBe(0);
      expect(fresh.output).toContain("No migrations to redo.");

      await migrateUp({ ...scenario.options, to: "2_b.js" });
      const unapplied = await runCli(["redo", "--to", "1_a.js"], env);
      expect(unapplied.exitCode).toBe(0);
      expect(unapplied.output).toContain("1_a.js is not applied");
    } finally {
      scenario.cleanup();
    }
  });

  it("keeps the reverted state visible when the up phase fails", async () => {
    const scenario = makeScenario("bunsql-redo-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "2_base.js", "base_table");
      writeMigration(
        scenario.listDir,
        "1_broken.js",
        "await tx`CREATE TABLE broken_table (id INTEGER)`;",
        "await tx`SELECT 1`;",
      );
      await migrateUp(scenario.options);
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };

      const redo = await runCli(["redo"], env);

      expect(redo.exitCode).toBe(1);
      expect(redo.output).toContain("1_broken.js rolled back");
      expect(redo.output).toContain("stay reverted");
      expect(readRecords(scenario.dbPath).map((record) => record.migration)).toEqual(["2_base.js"]);
    } finally {
      scenario.cleanup();
    }
  });
});
