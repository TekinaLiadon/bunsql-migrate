import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { migrateUp, migrateDown, installMigrations, ChecksumDriftError } from "../src/index.js";

const originalDatabaseUrl = process.env["DATABASE_URL"];

let dbPath: string;
let listDir: string;
let directImportDir: string;
let options: { databaseUrl: string; listDir: string };

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "bunsql-api-"));
  dbPath = path.join(dir, "migrate.db");
  listDir = path.join(dir, "list");
  directImportDir = path.join(dir, "list-direct");
  mkdirSync(listDir, { recursive: true });
  mkdirSync(directImportDir, { recursive: true });
  options = { databaseUrl: `sqlite:${dbPath}`, listDir };
  process.env["DATABASE_URL"] = options.databaseUrl;
});

afterAll(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env["DATABASE_URL"];
  } else {
    process.env["DATABASE_URL"] = originalDatabaseUrl;
  }
  rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

function writeMigration(file: string, upBody: string, downBody = ""): void {
  writeFileSync(
    path.join(listDir, file),
    `import { sql } from "bun";
const up = async () => {
  ${upBody}
};
const down = async () => {
  ${downBody}
};
export { up, down };
`,
  );
}

function readTables(): string[] {
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

function readRecorded(): string[] {
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

describe("Migration up/down through SQLite (default sql client)", () => {
  it("up() executes the migration and down() rolls it back", async () => {
    const file = "2025_01_01_120000_create_users.js";
    writeFileSync(
      path.join(directImportDir, file),
      `import { sql } from "bun";
const up = async () => {
  await sql\`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)\`;
};
const down = async () => {
  await sql\`DROP TABLE users\`;
};
export { up, down };
`,
    );
    const mod = await import(path.join(directImportDir, file));
    await mod.up();
    expect(readTables()).toContain("users");
    await mod.down();
    expect(readTables()).not.toContain("users");
  });
});

describe("installMigrations()", () => {
  it("creates the tracking table and is idempotent", async () => {
    await installMigrations(options);
    await installMigrations(options);
    expect(readTables()).toContain("migrations");
  });

  it("throws when no database URL is configured", async () => {
    delete process.env["DATABASE_URL"];
    try {
      await expect(installMigrations({ listDir })).rejects.toThrow("DATABASE_URL is not set");
    } finally {
      process.env["DATABASE_URL"] = options.databaseUrl;
    }
  });
});

describe("migrateUp()", () => {
  it("applies pending migrations and returns the applied list", async () => {
    writeMigration("2_second.js", "await sql`CREATE TABLE second_table (id INTEGER)`;");
    writeMigration("1_first.js", "await sql`CREATE TABLE first_table (id INTEGER)`;");

    const result = await migrateUp(options);

    expect(result.applied).toEqual(["2_second.js", "1_first.js"]);
    expect(readTables()).toContain("first_table");
    expect(readTables()).toContain("second_table");
    expect(readRecorded()).toEqual(["2_second.js", "1_first.js"]);
  });

  it("returns an empty list on a repeated run", async () => {
    writeMigration("1_once.js", "await sql`CREATE TABLE once_table (id INTEGER)`;");
    const first = await migrateUp(options);
    expect(first.applied).toEqual(["1_once.js"]);

    const second = await migrateUp(options);
    expect(second.applied).toEqual([]);
  });

  it("throws ChecksumDriftError when an applied migration file was modified", async () => {
    writeMigration("1_drift.js", "await sql`CREATE TABLE drift_table (id INTEGER)`;");
    await migrateUp(options);

    writeFileSync(path.join(listDir, "1_drift.js"), "// tampered content\n");

    await expect(migrateUp(options)).rejects.toBeInstanceOf(ChecksumDriftError);
    writeMigration("1_drift.js", "await sql`CREATE TABLE drift_table (id INTEGER)`;");
  });

  it("closes the driver connection after a failing migration", async () => {
    writeMigration("1_boom.js", "throw new Error('boom');");
    try {
      await expect(migrateUp(options)).rejects.toThrow("boom");
      await expect(migrateUp(options)).rejects.toThrow("boom");
    } finally {
      rmSync(path.join(listDir, "1_boom.js"));
    }
  });
});

describe("migrateDown()", () => {
  it("rolls back the last applied migration and removes its record", async () => {
    writeMigration(
      "1_rollback.js",
      "await sql`CREATE TABLE rollback_table (id INTEGER)`;",
      "await sql`DROP TABLE rollback_table`;",
    );
    await migrateUp(options);

    const result = await migrateDown(options);

    expect(result.reverted).toBe("1_rollback.js");
    expect(readTables()).not.toContain("rollback_table");
    expect(readRecorded()).not.toContain("1_rollback.js");
  });

  it("removes the tracking record when the migration has no down() export", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bunsql-api-nodown-"));
    try {
      const fileList = path.join(dir, "list");
      mkdirSync(fileList);
      writeFileSync(
        path.join(fileList, "1_nodown.js"),
        `import { sql } from "bun";
const up = async () => {
  await sql\`CREATE TABLE nodown_table (id INTEGER)\`;
};
export { up };
`,
      );

      const nodownOptions = {
        ...options,
        listDir: fileList,
        databaseUrl: `sqlite:${path.join(dir, "db.sqlite")}`,
      };
      await migrateUp(nodownOptions);
      const result = await migrateDown(nodownOptions);

      expect(result.reverted).toBe("1_nodown.js");
      const db = new Database(path.join(dir, "db.sqlite"));
      try {
        const recorded = db
          .query<{ migration: string }, []>("SELECT migration FROM migrations")
          .all()
          .map((row) => row.migration);
        expect(recorded).not.toContain("1_nodown.js");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a migration file without an up() export", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bunsql-api-noup-"));
    try {
      const fileList = path.join(dir, "list");
      mkdirSync(fileList);
      writeFileSync(path.join(fileList, "1_noup.js"), "export const down = async () => {};\n");

      const result = await migrateUp({
        ...options,
        listDir: fileList,
        databaseUrl: `sqlite:${path.join(dir, "db.sqlite")}`,
      });

      expect(result.applied).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills a legacy record with a NULL checksum on up", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bunsql-api-legacy-"));
    try {
      const fileList = path.join(dir, "list");
      mkdirSync(fileList);
      const legacyDbPath = path.join(dir, "db.sqlite");
      writeFileSync(
        path.join(fileList, "1_legacy.js"),
        `import { sql } from "bun";
const up = async () => {
  await sql\`CREATE TABLE legacy_table (id INTEGER)\`;
};
const down = async () => {};
export { up, down };
`,
      );

      const legacyOptions = {
        ...options,
        listDir: fileList,
        databaseUrl: `sqlite:${legacyDbPath}`,
      };
      await migrateUp(legacyOptions);

      const db = new Database(legacyDbPath);
      try {
        db.query("UPDATE migrations SET checksum = NULL").run();
      } finally {
        db.close();
      }

      const result = await migrateUp(legacyOptions);

      expect(result.applied).toEqual([]);
      const check = new Database(legacyDbPath);
      try {
        const row = check
          .query<{ checksum: string | null }, []>(
            "SELECT checksum FROM migrations WHERE migration = '1_legacy.js'",
          )
          .get();
        expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when there is nothing to revert", async () => {
    const db = new Database(dbPath);
    try {
      db.query("DELETE FROM migrations").run();
    } finally {
      db.close();
    }

    const result = await migrateDown(options);
    expect(result.reverted).toBeNull();
  });
});
