import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { migrateUp, migrateDown, migrateStatus } from "../src/index.js";

interface StatusScenario {
  options: { databaseUrl: string; listDir: string };
  dbPath: string;
  listDir: string;
  cleanup(): void;
}

function makeScenario(): StatusScenario {
  const dir = mkdtempSync(path.join(tmpdir(), "bunsql-status-"));
  const dbPath = path.join(dir, "status.db");
  const listDir = path.join(dir, "list");
  mkdirSync(listDir, { recursive: true });
  return {
    options: { databaseUrl: `sqlite:${dbPath}`, listDir },
    dbPath,
    listDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeMigration(listDir: string, file: string, upBody: string): void {
  writeFileSync(
    path.join(listDir, file),
    `const up = async (tx) => {
  ${upBody}
};
const down = async (tx) => {};
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

describe("migrateStatus()", () => {
  it("reports an empty status on a fresh database and creates the tracking table", async () => {
    const scenario = makeScenario();
    try {
      const status = await migrateStatus(scenario.options);

      expect(status.applied).toEqual([]);
      expect(status.pending).toEqual([]);
      expect(readTables(scenario.dbPath)).toContain("migrations");
    } finally {
      scenario.cleanup();
    }
  });

  it("splits applied and pending after a partial apply", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(
        scenario.listDir,
        "9_first.js",
        "await tx`CREATE TABLE first_table (id INTEGER)`;",
      );
      await migrateUp(scenario.options);
      writeMigration(
        scenario.listDir,
        "1_second.js",
        "await tx`CREATE TABLE second_table (id INTEGER)`;",
      );

      const status = await migrateStatus(scenario.options);

      expect(status.applied).toHaveLength(1);
      expect(status.applied[0]?.name).toBe("9_first.js");
      expect(status.applied[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(status.pending).toEqual(["1_second.js"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("reports nothing pending when every file is applied", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(
        scenario.listDir,
        "9_first.js",
        "await tx`CREATE TABLE first_table (id INTEGER)`;",
      );
      writeMigration(
        scenario.listDir,
        "1_second.js",
        "await tx`CREATE TABLE second_table (id INTEGER)`;",
      );
      await migrateUp(scenario.options);

      const status = await migrateStatus(scenario.options);

      expect(status.applied).toHaveLength(2);
      expect(status.pending).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("returns a migration to pending after down", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(
        scenario.listDir,
        "9_first.js",
        "await tx`CREATE TABLE first_table (id INTEGER)`;",
      );
      writeMigration(
        scenario.listDir,
        "1_second.js",
        "await tx`CREATE TABLE second_table (id INTEGER)`;",
      );
      await migrateUp(scenario.options);

      await migrateDown(scenario.options);
      const status = await migrateStatus(scenario.options);

      expect(status.applied.map((entry) => entry.name)).toEqual(["9_first.js"]);
      expect(status.pending).toEqual(["1_second.js"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("lists pending files in application order (descending filename)", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(
        scenario.listDir,
        "3_alpha.js",
        "await tx`CREATE TABLE alpha_table (id INTEGER)`;",
      );
      writeMigration(
        scenario.listDir,
        "2_beta.js",
        "await tx`CREATE TABLE beta_table (id INTEGER)`;",
      );
      writeMigration(
        scenario.listDir,
        "1_gamma.js",
        "await tx`CREATE TABLE gamma_table (id INTEGER)`;",
      );

      const status = await migrateStatus(scenario.options);

      expect(status.pending).toEqual(["3_alpha.js", "2_beta.js", "1_gamma.js"]);
    } finally {
      scenario.cleanup();
    }
  });
});
