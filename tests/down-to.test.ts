import { describe, it, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { migrateDown, migrateUp, MigrationNotFoundError } from "../src/index.js";
import { makeScenario, readRecorded, readTables, runCli } from "./helpers.js";

function writeTableMigration(listDir: string, file: string, table: string): void {
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

function writeScenario(listDir: string): void {
  writeTableMigration(listDir, "4_d.js", "d_table");
  writeTableMigration(listDir, "3_c.js", "c_table");
  writeTableMigration(listDir, "2_b.js", "b_table");
  writeTableMigration(listDir, "1_a.js", "a_table");
}

describe("migrateDown to", () => {
  it("reverts down to the target inclusive, older migrations stay applied", async () => {
    const scenario = makeScenario("bunsql-down-to-");
    try {
      writeScenario(scenario.listDir);
      await migrateUp(scenario.options);

      const result = await migrateDown({ ...scenario.options, to: "2_b.js" });

      expect(result.reverted).toEqual(["1_a.js", "2_b.js"]);
      expect(readRecorded(scenario.dbPath)).toEqual(["4_d.js", "3_c.js"]);
      for (const table of ["c_table", "d_table"]) {
        expect(readTables(scenario.dbPath)).toContain(table);
      }
      for (const table of ["a_table", "b_table"]) {
        expect(readTables(scenario.dbPath)).not.toContain(table);
      }
    } finally {
      scenario.cleanup();
    }
  });

  it("reverts everything when the target is the oldest applied migration", async () => {
    const scenario = makeScenario("bunsql-down-to-");
    try {
      writeScenario(scenario.listDir);
      await migrateUp(scenario.options);

      const result = await migrateDown({ ...scenario.options, to: "4_d.js" });

      expect(result.reverted).toEqual(["1_a.js", "2_b.js", "3_c.js", "4_d.js"]);
      expect(readRecorded(scenario.dbPath)).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("throws MigrationNotFoundError before any writes for an unknown target", async () => {
    const scenario = makeScenario("bunsql-down-to-");
    try {
      writeScenario(scenario.listDir);
      await migrateUp(scenario.options);
      const before = readRecorded(scenario.dbPath);

      await expect(migrateDown({ ...scenario.options, to: "nope.js" })).rejects.toBeInstanceOf(
        MigrationNotFoundError,
      );

      expect(readRecorded(scenario.dbPath)).toEqual(before);
      expect(readTables(scenario.dbPath)).not.toContain("missing_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("does not even create the tracking table for an unknown target on a fresh database", async () => {
    const scenario = makeScenario("bunsql-down-to-");
    try {
      writeScenario(scenario.listDir);

      await expect(migrateDown({ ...scenario.options, to: "nope.js" })).rejects.toBeInstanceOf(
        MigrationNotFoundError,
      );

      expect(readTables(scenario.dbPath)).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("reports a no-op for a target that is still pending", async () => {
    const scenario = makeScenario("bunsql-down-to-");
    try {
      writeScenario(scenario.listDir);
      await migrateUp({ ...scenario.options, to: "2_b.js" });

      const result = await migrateDown({ ...scenario.options, to: "1_a.js" });

      expect(result.reverted).toEqual([]);
      expect(readRecorded(scenario.dbPath)).toEqual(["4_d.js", "3_c.js", "2_b.js"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects to combined with steps before any writes", async () => {
    const scenario = makeScenario("bunsql-down-to-");
    try {
      writeScenario(scenario.listDir);
      await migrateUp(scenario.options);
      const before = readRecorded(scenario.dbPath);

      await expect(migrateDown({ ...scenario.options, to: "2_b.js", steps: 2 })).rejects.toThrow(
        /cannot be combined/,
      );
      await expect(
        migrateDown({ ...scenario.options, to: "2_b.js", steps: "all" }),
      ).rejects.toThrow(/cannot be combined/);

      expect(readRecorded(scenario.dbPath)).toEqual(before);
    } finally {
      scenario.cleanup();
    }
  });

  it("plans the window in dry run without reverting anything", async () => {
    const scenario = makeScenario("bunsql-down-to-");
    try {
      writeScenario(scenario.listDir);
      await migrateUp(scenario.options);
      const before = readRecorded(scenario.dbPath);

      const result = await migrateDown({ ...scenario.options, to: "3_c.js", dryRun: true });

      expect(result.reverted).toEqual([]);
      expect(result.planned).toEqual(["1_a.js", "2_b.js", "3_c.js"]);
      expect(readRecorded(scenario.dbPath)).toEqual(before);
    } finally {
      scenario.cleanup();
    }
  });
});

describe("CLI down --to", () => {
  const env = (databaseUrl: string): Record<string, string> => ({
    ...process.env,
    DATABASE_URL: databaseUrl,
  });

  it("reverts down to the target inclusive", async () => {
    const scenario = makeScenario("bunsql-down-to-cli-");
    try {
      writeScenario(scenario.listDir);
      await migrateUp(scenario.options);

      const run = await runCli(
        ["down", "--to", "2_b.js", "--dir", scenario.listDir],
        env(scenario.options.databaseUrl),
      );

      expect(run.exitCode).toBe(0);
      expect(run.output).toContain("1_a.js rolled back");
      expect(run.output).toContain("2_b.js rolled back");
      expect(run.output).toContain("Reverted 2 migration(s).");
      expect(readRecorded(scenario.dbPath)).toEqual(["4_d.js", "3_c.js"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("exits 1 for an unknown target without reverting anything", async () => {
    const scenario = makeScenario("bunsql-down-to-cli-");
    try {
      writeScenario(scenario.listDir);
      await migrateUp(scenario.options);
      const before = readRecorded(scenario.dbPath);

      const run = await runCli(
        ["down", "--to", "nope.js", "--dir", scenario.listDir],
        env(scenario.options.databaseUrl),
      );

      expect(run.exitCode).toBe(1);
      expect(run.output).toContain("nope.js is not in the migrations directory");
      expect(readRecorded(scenario.dbPath)).toEqual(before);
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects --to combined with a step count or --all", async () => {
    const scenario = makeScenario("bunsql-down-to-cli-");
    try {
      writeScenario(scenario.listDir);
      await migrateUp(scenario.options);

      const withSteps = await runCli(
        ["down", "--to", "2_b.js", "3", "--dir", scenario.listDir],
        env(scenario.options.databaseUrl),
      );
      expect(withSteps.exitCode).toBe(1);
      expect(withSteps.output).toContain("not more than one of them");

      const withAll = await runCli(
        ["down", "--to", "2_b.js", "--all", "--dir", scenario.listDir],
        env(scenario.options.databaseUrl),
      );
      expect(withAll.exitCode).toBe(1);
      expect(withAll.output).toContain("not more than one of them");

      expect(readRecorded(scenario.dbPath)).toEqual(["4_d.js", "3_c.js", "2_b.js", "1_a.js"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("exits 0 and reverts nothing for a pending target", async () => {
    const scenario = makeScenario("bunsql-down-to-cli-");
    try {
      writeScenario(scenario.listDir);
      await migrateUp({ ...scenario.options, to: "2_b.js" });

      const run = await runCli(
        ["down", "--to", "1_a.js", "--dir", scenario.listDir],
        env(scenario.options.databaseUrl),
      );

      expect(run.exitCode).toBe(0);
      expect(run.output).toContain("1_a.js is not applied");
      expect(readRecorded(scenario.dbPath)).toEqual(["4_d.js", "3_c.js", "2_b.js"]);
    } finally {
      scenario.cleanup();
    }
  });
});
