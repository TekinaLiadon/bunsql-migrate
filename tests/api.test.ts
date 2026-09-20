import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  migrateUp,
  migrateDown,
  installMigrations,
  ChecksumDriftError,
  MigrationNotFoundError,
} from "../src/index.js";

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

function readTables(file: string = dbPath): string[] {
  const db = new Database(file);
  try {
    return db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function readRecorded(file: string = dbPath): string[] {
  const db = new Database(file);
  try {
    return db
      .query<{ migration: string }, []>("SELECT migration FROM migrations ORDER BY id ASC")
      .all()
      .map((row) => row.migration);
  } finally {
    db.close();
  }
}

function readRowCount(table: string, file: string = dbPath): number {
  const db = new Database(file);
  try {
    const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return row?.n ?? 0;
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

    expect(result.reverted).toEqual(["1_rollback.js"]);
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

      expect(result.reverted).toEqual(["1_nodown.js"]);
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

  it("returns an empty list when there is nothing to revert", async () => {
    const db = new Database(dbPath);
    try {
      db.query("DELETE FROM migrations").run();
    } finally {
      db.close();
    }

    const result = await migrateDown(options);
    expect(result.reverted).toEqual([]);
  });

  it("returns an empty list on a database without the tracking table", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bunsql-api-fresh-"));
    try {
      const freshDbPath = path.join(dir, "fresh.sqlite");

      const result = await migrateDown({
        ...options,
        databaseUrl: `sqlite:${freshDbPath}`,
      });

      expect(result.reverted).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("transactional migrations (up(tx) / down(tx))", () => {
  const originalTxDatabaseUrl = process.env["DATABASE_URL"];
  let txDir: string;
  let txDbPath: string;
  let txListDir: string;
  let txOptions: { databaseUrl: string; listDir: string };

  beforeAll(() => {
    txDir = mkdtempSync(path.join(tmpdir(), "bunsql-api-tx-"));
    txDbPath = path.join(txDir, "migrate.db");
    txListDir = path.join(txDir, "list");
    mkdirSync(txListDir, { recursive: true });
    txOptions = { databaseUrl: `sqlite:${txDbPath}`, listDir: txListDir };
    process.env["DATABASE_URL"] = txOptions.databaseUrl;
  });

  afterAll(() => {
    if (originalTxDatabaseUrl === undefined) {
      delete process.env["DATABASE_URL"];
    } else {
      process.env["DATABASE_URL"] = originalTxDatabaseUrl;
    }
    rmSync(txDir, { recursive: true, force: true });
  });

  it("applies a tx migration inside a transaction and records it", async () => {
    writeFileSync(
      path.join(txListDir, "1_tx_apply.js"),
      `const up = async (tx) => {
  await tx\`CREATE TABLE tx_apply_table (id INTEGER PRIMARY KEY, name TEXT)\`;
  await tx\`INSERT INTO tx_apply_table (id, name) VALUES (1, 'one')\`;
};
const down = async (tx) => {
  await tx\`DROP TABLE tx_apply_table\`;
};
export { up, down };
`,
    );

    const result = await migrateUp(txOptions);

    expect(result.applied).toEqual(["1_tx_apply.js"]);
    expect(readTables(txDbPath)).toContain("tx_apply_table");
    expect(readRecorded(txDbPath)).toContain("1_tx_apply.js");
    expect(readRowCount("tx_apply_table", txDbPath)).toBe(1);
  });

  it("rolls back a failed tx migration and leaves no tracking record", async () => {
    const file = path.join(txListDir, "1_tx_rollback.js");
    writeFileSync(
      file,
      `const up = async (tx) => {
  await tx\`CREATE TABLE tx_rollback_table (id INTEGER PRIMARY KEY, name TEXT)\`;
  await tx\`INSERT INTO tx_rollback_table (id, name) VALUES (1, 'one')\`;
  throw new Error("tx-boom");
};
const down = async () => {};
export { up, down };
`,
    );

    await expect(migrateUp(txOptions)).rejects.toThrow("tx-boom");
    expect(readTables(txDbPath)).not.toContain("tx_rollback_table");
    expect(readRecorded(txDbPath)).not.toContain("1_tx_rollback.js");
    rmSync(file);

    writeFileSync(
      path.join(txListDir, "1_tx_retry.js"),
      `const up = async (tx) => {
  await tx\`CREATE TABLE tx_rollback_table (id INTEGER PRIMARY KEY, name TEXT)\`;
  await tx\`INSERT INTO tx_rollback_table (id, name) VALUES (1, 'one')\`;
};
const down = async (tx) => {
  await tx\`DROP TABLE tx_rollback_table\`;
};
export { up, down };
`,
    );

    const result = await migrateUp(txOptions);
    expect(result.applied).toEqual(["1_tx_retry.js"]);
    expect(readRowCount("tx_rollback_table", txDbPath)).toBe(1);
  });

  it("runs down(tx) inside a transaction", async () => {
    writeFileSync(
      path.join(txListDir, "1_tx_down.js"),
      `const up = async (tx) => {
  await tx\`CREATE TABLE tx_down_table (id INTEGER PRIMARY KEY)\`;
};
const down = async (tx) => {
  await tx\`DROP TABLE tx_down_table\`;
};
export { up, down };
`,
    );
    await migrateUp(txOptions);

    const result = await migrateDown(txOptions);

    expect(result.reverted).toEqual(["1_tx_down.js"]);
    expect(readTables(txDbPath)).not.toContain("tx_down_table");
    expect(readRecorded(txDbPath)).not.toContain("1_tx_down.js");
  });
});

describe("migrateDown() steps", () => {
  interface StepsScenario {
    options: { databaseUrl: string; listDir: string };
    dbPath: string;
    cleanup(): void;
  }

  function makeScenario(): StepsScenario {
    const dir = mkdtempSync(path.join(tmpdir(), "bunsql-steps-"));
    const dbFile = path.join(dir, "db.sqlite");
    const fileList = path.join(dir, "list");
    mkdirSync(fileList, { recursive: true });
    return {
      options: { databaseUrl: `sqlite:${dbFile}`, listDir: fileList },
      dbPath: dbFile,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  function writeTableMigration(
    fileList: string,
    file: string,
    table: string,
    downBody = `await tx\`DROP TABLE ${table}\`;`,
  ): void {
    writeFileSync(
      path.join(fileList, file),
      `const up = async (tx) => {
  await tx\`CREATE TABLE ${table} (id INTEGER)\`;
};
const down = async (tx) => {
  ${downBody}
};
export { up, down };
`,
    );
  }

  it("rolls back N migrations in reverse apply order with steps", async () => {
    const scenario = makeScenario();
    try {
      writeTableMigration(scenario.options.listDir, "1_a.js", "a_table");
      writeTableMigration(scenario.options.listDir, "2_b.js", "b_table");
      writeTableMigration(scenario.options.listDir, "3_c.js", "c_table");
      await migrateUp(scenario.options);

      const result = await migrateDown({ ...scenario.options, steps: 2 });

      expect(result.reverted).toEqual(["1_a.js", "2_b.js"]);
      expect(readRecorded(scenario.dbPath)).toEqual(["3_c.js"]);
      expect(readTables(scenario.dbPath)).toContain("c_table");
      expect(readTables(scenario.dbPath)).not.toContain("b_table");
      expect(readTables(scenario.dbPath)).not.toContain("a_table");
    } finally {
      scenario.cleanup();
    }
  });

  it('reverts everything with steps: "all"', async () => {
    const scenario = makeScenario();
    try {
      writeTableMigration(scenario.options.listDir, "1_a.js", "a_table");
      writeTableMigration(scenario.options.listDir, "2_b.js", "b_table");
      writeTableMigration(scenario.options.listDir, "3_c.js", "c_table");
      await migrateUp(scenario.options);

      const result = await migrateDown({ ...scenario.options, steps: "all" });

      expect(result.reverted).toEqual(["1_a.js", "2_b.js", "3_c.js"]);
      expect(readRecorded(scenario.dbPath)).toEqual([]);
      expect(readTables(scenario.dbPath)).not.toContain("a_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("reverts everything when steps exceed the applied count", async () => {
    const scenario = makeScenario();
    try {
      writeTableMigration(scenario.options.listDir, "1_a.js", "a_table");
      writeTableMigration(scenario.options.listDir, "2_b.js", "b_table");
      await migrateUp(scenario.options);

      const result = await migrateDown({ ...scenario.options, steps: 10 });

      expect(result.reverted).toEqual(["1_a.js", "2_b.js"]);
      expect(readRecorded(scenario.dbPath)).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("stops at the first failed rollback and keeps earlier rollbacks", async () => {
    const scenario = makeScenario();
    try {
      writeTableMigration(scenario.options.listDir, "1_a.js", "a_table");
      writeTableMigration(
        scenario.options.listDir,
        "2_boom.js",
        "boom_table",
        `throw new Error("down-boom");`,
      );
      writeTableMigration(scenario.options.listDir, "3_c.js", "c_table");
      await migrateUp(scenario.options);

      await expect(migrateDown({ ...scenario.options, steps: "all" })).rejects.toThrow("down-boom");

      expect(readRecorded(scenario.dbPath)).toEqual(["3_c.js", "2_boom.js"]);
      expect(readTables(scenario.dbPath)).toContain("c_table");
      expect(readTables(scenario.dbPath)).toContain("boom_table");
      expect(readTables(scenario.dbPath)).not.toContain("a_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("throws on an invalid steps value without touching the database", async () => {
    const scenario = makeScenario();
    try {
      writeTableMigration(scenario.options.listDir, "1_a.js", "a_table");
      await migrateUp(scenario.options);

      await expect(migrateDown({ ...scenario.options, steps: 0 })).rejects.toThrow(/Invalid steps/);
      await expect(migrateDown({ ...scenario.options, steps: 1.5 })).rejects.toThrow(
        /Invalid steps/,
      );
      expect(readRecorded(scenario.dbPath)).toEqual(["1_a.js"]);
    } finally {
      scenario.cleanup();
    }
  });
});

describe("migrateUp() with to", () => {
  interface ToScenario {
    options: { databaseUrl: string; listDir: string };
    dbPath: string;
    cleanup(): void;
  }

  function makeScenario(): ToScenario {
    const dir = mkdtempSync(path.join(tmpdir(), "bunsql-to-"));
    const dbFile = path.join(dir, "db.sqlite");
    const fileList = path.join(dir, "list");
    mkdirSync(fileList, { recursive: true });
    return {
      options: { databaseUrl: `sqlite:${dbFile}`, listDir: fileList },
      dbPath: dbFile,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  function writeTableMigration(fileList: string, file: string, table: string): void {
    writeFileSync(
      path.join(fileList, file),
      `const up = async (tx) => {
  await tx\`CREATE TABLE ${table} (id INTEGER)\`;
};
const down = async (tx) => {};
export { up, down };
`,
    );
  }

  it("applies pending migrations up to and including the target", async () => {
    const scenario = makeScenario();
    try {
      writeTableMigration(scenario.options.listDir, "1_a.js", "a_table");
      writeTableMigration(scenario.options.listDir, "2_b.js", "b_table");
      writeTableMigration(scenario.options.listDir, "3_c.js", "c_table");

      const result = await migrateUp({ ...scenario.options, to: "2_b.js" });

      expect(result.applied).toEqual(["3_c.js", "2_b.js"]);
      expect(readRecorded(scenario.dbPath)).toEqual(["3_c.js", "2_b.js"]);
      expect(readTables(scenario.dbPath)).toContain("b_table");
      expect(readTables(scenario.dbPath)).not.toContain("a_table");

      const rest = await migrateUp(scenario.options);
      expect(rest.applied).toEqual(["1_a.js"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("does nothing when the target is already applied", async () => {
    const scenario = makeScenario();
    try {
      writeTableMigration(scenario.options.listDir, "1_a.js", "a_table");
      writeTableMigration(scenario.options.listDir, "2_b.js", "b_table");
      await migrateUp({ ...scenario.options, to: "2_b.js" });

      const result = await migrateUp({ ...scenario.options, to: "2_b.js" });

      expect(result.applied).toEqual([]);
      expect(readRecorded(scenario.dbPath)).toEqual(["2_b.js"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("throws MigrationNotFoundError for an unknown target before applying anything", async () => {
    const scenario = makeScenario();
    try {
      writeTableMigration(scenario.options.listDir, "1_a.js", "a_table");

      await expect(migrateUp({ ...scenario.options, to: "missing.js" })).rejects.toBeInstanceOf(
        MigrationNotFoundError,
      );
      expect(readRecorded(scenario.dbPath)).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });
});
