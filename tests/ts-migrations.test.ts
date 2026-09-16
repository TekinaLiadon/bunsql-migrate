import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { migrateUp, migrateDown, createMigration, ChecksumDriftError } from "../src/index.js";

interface MigrationScenario {
  options: { databaseUrl: string; listDir: string };
  dbPath: string;
  listDir: string;
  cleanup(): void;
}

function makeScenario(): MigrationScenario {
  const dir = mkdtempSync(path.join(tmpdir(), "bunsql-ts-"));
  const dbPath = path.join(dir, "migrate.db");
  const listDir = path.join(dir, "list");
  mkdirSync(listDir, { recursive: true });
  return {
    options: { databaseUrl: `sqlite:${dbPath}`, listDir },
    dbPath,
    listDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeMigration(listDir: string, file: string, upBody: string, downBody = ""): void {
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

function readTables(dbPath: string): string[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function readRecorded(dbPath: string): string[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ migration: string }, []>("SELECT migration FROM migrations ORDER BY id ASC")
      .all()
      .map((row) => row.migration);
  } finally {
    db.close();
  }
}

describe("TypeScript migration files", () => {
  it("applies .js and .ts migrations interleaved in pure filename order", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(
        scenario.listDir,
        "1_first.js",
        "await tx`CREATE TABLE first_table (id INTEGER)`;",
      );
      writeMigration(
        scenario.listDir,
        "2_second.ts",
        "await tx`CREATE TABLE second_table (id INTEGER)`;",
      );
      writeMigration(
        scenario.listDir,
        "3_third.js",
        "await tx`CREATE TABLE third_table (id INTEGER)`;",
      );

      const result = await migrateUp(scenario.options);

      expect(result.applied).toEqual(["3_third.js", "2_second.ts", "1_first.js"]);
      expect(readRecorded(scenario.dbPath)).toEqual(["3_third.js", "2_second.ts", "1_first.js"]);
      for (const table of ["first_table", "second_table", "third_table"]) {
        expect(readTables(scenario.dbPath)).toContain(table);
      }
    } finally {
      scenario.cleanup();
    }
  });

  it("detects checksum drift on a modified .ts migration", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(
        scenario.listDir,
        "1_drift.ts",
        "await tx`CREATE TABLE drift_table (id INTEGER)`;",
      );
      await migrateUp(scenario.options);

      writeFileSync(path.join(scenario.listDir, "1_drift.ts"), "// tampered content\n");

      await expect(migrateUp(scenario.options)).rejects.toBeInstanceOf(ChecksumDriftError);
    } finally {
      scenario.cleanup();
    }
  });

  it("rolls a .ts migration back with down()", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(
        scenario.listDir,
        "1_rollback.ts",
        "await tx`CREATE TABLE rollback_table (id INTEGER)`;",
        "await tx`DROP TABLE rollback_table`;",
      );
      await migrateUp(scenario.options);

      const result = await migrateDown(scenario.options);

      expect(result.reverted).toEqual(["1_rollback.ts"]);
      expect(readTables(scenario.dbPath)).not.toContain("rollback_table");
      expect(readRecorded(scenario.dbPath)).not.toContain("1_rollback.ts");
    } finally {
      scenario.cleanup();
    }
  });

  it("createMigration generates a runnable .ts stub by default", async () => {
    const scenario = makeScenario();
    try {
      const filename = await createMigration({ name: "stub_run", listDir: scenario.listDir });

      expect(filename).toMatch(/^\d{13}_\d{4}_\d{2}_\d{2}_stub_run\.ts$/);
      const content = await Bun.file(path.join(scenario.listDir, filename)).text();
      expect(content).toContain("async (tx: SQL)");

      const result = await migrateUp(scenario.options);
      expect(result.applied).toEqual([filename]);
      expect(readRecorded(scenario.dbPath)).toEqual([filename]);

      await migrateDown(scenario.options);
      expect(readRecorded(scenario.dbPath)).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it('createMigration generates a runnable .js stub with lang: "js"', async () => {
    const scenario = makeScenario();
    try {
      const filename = await createMigration({
        name: "js_run",
        listDir: scenario.listDir,
        lang: "js",
      });

      expect(filename).toMatch(/^\d{13}_\d{4}_\d{2}_\d{2}_js_run\.js$/);
      const content = await Bun.file(path.join(scenario.listDir, filename)).text();
      expect(content).toContain("async (tx)");
      expect(content).not.toContain(": SQL");

      const result = await migrateUp(scenario.options);
      expect(result.applied).toEqual([filename]);
      expect(readRecorded(scenario.dbPath)).toEqual([filename]);

      await migrateDown(scenario.options);
      expect(readRecorded(scenario.dbPath)).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });
});
