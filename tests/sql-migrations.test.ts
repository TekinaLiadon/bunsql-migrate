import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { migrateUp, migrateDown, migrateStatus, ChecksumDriftError } from "../src/index.js";

interface SqlScenario {
  options: { databaseUrl: string; listDir: string };
  dbPath: string;
  listDir: string;
  cleanup(): void;
}

function makeScenario(): SqlScenario {
  const dir = mkdtempSync(path.join(tmpdir(), "bunsql-sqlmig-"));
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

function writeJsMigration(listDir: string, file: string, table: string): void {
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

function writeSqlPair(listDir: string, name: string, upSql: string, downSql?: string): string {
  writeFileSync(path.join(listDir, `${name}.up.sql`), upSql);
  if (downSql !== undefined) {
    writeFileSync(path.join(listDir, `${name}.down.sql`), downSql);
  }
  return `${name}.up.sql`;
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

function readRowCount(dbPath: string, table: string): number {
  const db = new Database(dbPath);
  try {
    const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

describe("SQL migration pairs", () => {
  it("applies .up.sql migrations interleaved with .js/.ts in pure filename order", async () => {
    const scenario = makeScenario();
    try {
      writeJsMigration(scenario.listDir, "1_first.js", "first_table");
      writeSqlPair(
        scenario.listDir,
        "2_second",
        "CREATE TABLE second_table (id INTEGER, name TEXT);\nINSERT INTO second_table (id, name) VALUES (1, 'row');\n",
      );
      writeFileSync(
        path.join(scenario.listDir, "3_third.ts"),
        `const up = async (tx) => {
  await tx\`CREATE TABLE third_table (id INTEGER)\`;
};
const down = async (tx) => {};
export { up, down };
`,
      );
      writeSqlPair(scenario.listDir, "4_fourth", "CREATE TABLE fourth_table (id INTEGER);");

      const result = await migrateUp(scenario.options);

      expect(result.applied).toEqual([
        "4_fourth.up.sql",
        "3_third.ts",
        "2_second.up.sql",
        "1_first.js",
      ]);
      expect(readRecorded(scenario.dbPath)).toEqual(result.applied);
      expect(readTables(scenario.dbPath)).toContain("first_table");
      expect(readTables(scenario.dbPath)).toContain("second_table");
      expect(readTables(scenario.dbPath)).toContain("third_table");
      expect(readTables(scenario.dbPath)).toContain("fourth_table");
      expect(readRowCount(scenario.dbPath, "second_table")).toBe(1);
    } finally {
      scenario.cleanup();
    }
  });

  it("rolls a .sql migration back through its .down.sql pair", async () => {
    const scenario = makeScenario();
    try {
      writeSqlPair(
        scenario.listDir,
        "1_pair",
        "CREATE TABLE pair_table (id INTEGER);\nINSERT INTO pair_table (id) VALUES (1);\n",
        "DELETE FROM pair_table;\nDROP TABLE pair_table;\n",
      );

      await migrateUp(scenario.options);
      const result = await migrateDown(scenario.options);

      expect(result.reverted).toEqual(["1_pair.up.sql"]);
      expect(readTables(scenario.dbPath)).not.toContain("pair_table");
      expect(readRecorded(scenario.dbPath)).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("removes the tracking record when the .up.sql has no .down.sql pair", async () => {
    const scenario = makeScenario();
    try {
      writeSqlPair(scenario.listDir, "1_nopair", "CREATE TABLE nopair_table (id INTEGER);");

      await migrateUp(scenario.options);
      const result = await migrateDown(scenario.options);

      expect(result.reverted).toEqual(["1_nopair.up.sql"]);
      expect(readTables(scenario.dbPath)).toContain("nopair_table");
      expect(readRecorded(scenario.dbPath)).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("detects checksum drift on a modified .up.sql file", async () => {
    const scenario = makeScenario();
    try {
      writeSqlPair(scenario.listDir, "1_drift", "CREATE TABLE drift_table (id INTEGER);");
      await migrateUp(scenario.options);

      writeFileSync(
        path.join(scenario.listDir, "1_drift.up.sql"),
        "CREATE TABLE drift_table_v2 (id INTEGER);",
      );

      await expect(migrateUp(scenario.options)).rejects.toBeInstanceOf(ChecksumDriftError);
    } finally {
      scenario.cleanup();
    }
  });

  it("rolls a failed multi-statement .up.sql back entirely and records nothing", async () => {
    const scenario = makeScenario();
    try {
      writeSqlPair(
        scenario.listDir,
        "1_boom",
        "CREATE TABLE boom_table (id INTEGER);\nINSERT INTO missing_table (id) VALUES (1);\n",
      );

      await expect(migrateUp(scenario.options)).rejects.toThrow();

      expect(readTables(scenario.dbPath)).not.toContain("boom_table");
      expect(readRecorded(scenario.dbPath)).toEqual([]);

      writeFileSync(
        path.join(scenario.listDir, "1_boom.up.sql"),
        "CREATE TABLE boom_table (id INTEGER);",
      );
      const retry = await migrateUp(scenario.options);
      expect(retry.applied).toEqual(["1_boom.up.sql"]);
      expect(readTables(scenario.dbPath)).toContain("boom_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("applies a .up.sql target with to", async () => {
    const scenario = makeScenario();
    try {
      writeSqlPair(scenario.listDir, "1_a", "CREATE TABLE sql_a (id INTEGER);");
      writeSqlPair(scenario.listDir, "2_b", "CREATE TABLE sql_b (id INTEGER);");

      const result = await migrateUp({ ...scenario.options, to: "2_b.up.sql" });

      expect(result.applied).toEqual(["2_b.up.sql"]);
      expect(readTables(scenario.dbPath)).not.toContain("sql_a");

      const status = await migrateStatus(scenario.options);
      expect(status.pending).toEqual(["1_a.up.sql"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("ignores a .down.sql file without its .up.sql pair", async () => {
    const scenario = makeScenario();
    try {
      writeJsMigration(scenario.listDir, "1_only.js", "only_table");
      writeFileSync(path.join(scenario.listDir, "9_orphan.down.sql"), "DROP TABLE nothing;");

      const status = await migrateStatus(scenario.options);

      expect(status.pending).toEqual(["1_only.js"]);
      const result = await migrateUp(scenario.options);
      expect(result.applied).toEqual(["1_only.js"]);
    } finally {
      scenario.cleanup();
    }
  });
});
