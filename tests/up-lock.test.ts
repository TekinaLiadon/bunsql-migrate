import { describe, it, expect } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDriver, migrateUp } from "../src/index.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/drivers/sqlite.js";
import { makeScenario, readRowCount, readRecorded, runCli } from "./helpers.js";

function writeMigration(listDir: string, file: string, body: string): void {
  writeFileSync(path.join(listDir, file), body);
}

function failingMigrationFile(table: string): string {
  return `const up = async (tx) => {
  await tx\`CREATE TABLE ${table} (id INTEGER)\`;
  throw new Error("migration-boom");
};
const down = async (tx) => {};
export { up, down };
`;
}

function passingMigrationFile(table: string): string {
  return `const up = async (tx) => {
  await tx\`CREATE TABLE ${table} (id INTEGER)\`;
};
const down = async (tx) => {};
export { up, down };
`;
}

async function readTables(dbUrl: string): Promise<string[]> {
  const driver = await createDriver(dbUrl);
  try {
    const rows = (await driver.transaction(
      (tx) => tx`SELECT name FROM sqlite_master WHERE type = 'table'`,
    )) as Array<{ name: string }>;
    return rows.map((row) => row.name);
  } finally {
    await driver.close();
  }
}

describe("migrateUp() locking on SQLite", () => {
  it("releases the lock when a migration fails and lets the next up succeed", async () => {
    const scenario = makeScenario("bunsql-up-lock-", "lock.db");
    try {
      const boomFile = "9_boom.js";
      const okFile = "1_ok.js";
      writeMigration(scenario.listDir, boomFile, failingMigrationFile("boom_table"));
      writeMigration(scenario.listDir, okFile, passingMigrationFile("ok_table"));

      await expect(migrateUp(scenario.options)).rejects.toThrow("migration-boom");
      expect(await readTables(scenario.options.databaseUrl)).not.toContain("boom_table");

      unlinkSync(path.join(scenario.listDir, boomFile));
      const fixedFile = "8_boom_fixed.js";
      writeMigration(scenario.listDir, fixedFile, passingMigrationFile("boom_table"));
      const second = await migrateUp(scenario.options);
      expect(second.applied).toEqual([fixedFile, okFile]);
      expect(await readTables(scenario.options.databaseUrl)).toEqual(
        expect.arrayContaining(["boom_table", "ok_table"]),
      );
    } finally {
      scenario.cleanup();
    }
  });

  it("validates lockTimeout before touching the database", async () => {
    const scenario = makeScenario("bunsql-up-lock-", "lock.db");
    try {
      await expect(migrateUp({ ...scenario.options, lockTimeout: -1 })).rejects.toThrow(
        /lockTimeout/,
      );
      await expect(migrateUp({ ...scenario.options, lockTimeout: 1.5 })).rejects.toThrow(
        /lockTimeout/,
      );
    } finally {
      scenario.cleanup();
    }
  });

  it("gives the sqlite driver a working tryLock/releaseLock pair", async () => {
    const scenario = makeScenario("bunsql-up-lock-", "lock.db");
    try {
      const driver = await createDriver(scenario.options.databaseUrl);
      try {
        await driver.install();
        const { tryLock, releaseLock } = driver;
        if (tryLock === undefined || releaseLock === undefined) {
          throw new Error("sqlite driver must support the lock interface");
        }
        await expect(tryLock(5)).resolves.toBe(true);
        await expect(tryLock(5)).resolves.toBe(true);
        await releaseLock();
        await releaseLock();
      } finally {
        await driver.close();
      }
    } finally {
      scenario.cleanup();
    }
  });

  it("keeps the default busy_timeout across the lock lifecycle", async () => {
    const scenario = makeScenario("bunsql-up-lock-", "lock.db");
    try {
      const driver = await createDriver(scenario.options.databaseUrl);
      try {
        const { tryLock, releaseLock, client } = driver;
        if (tryLock === undefined || releaseLock === undefined || client === undefined) {
          throw new Error("sqlite driver must support the lock interface");
        }
        const busyTimeout = async (): Promise<number | undefined> => {
          const rows = (await client().unsafe("PRAGMA busy_timeout")) as Array<{
            timeout: number;
          }>;
          return rows[0]?.timeout;
        };

        expect(await busyTimeout()).toBe(DEFAULT_BUSY_TIMEOUT_MS);
        await expect(tryLock(5)).resolves.toBe(true);
        expect(await busyTimeout()).toBe(DEFAULT_BUSY_TIMEOUT_MS);
        await releaseLock();
        expect(await busyTimeout()).toBe(DEFAULT_BUSY_TIMEOUT_MS);
      } finally {
        await driver.close();
      }
    } finally {
      scenario.cleanup();
    }
  });

  it("makes a second connection wait for the file write lock up to the busy timeout", async () => {
    const scenario = makeScenario("bunsql-up-lock-", "lock.db");
    try {
      const first = await createDriver(scenario.options.databaseUrl);
      const second = await createDriver(scenario.options.databaseUrl);
      try {
        await first.install();
        await second.install();

        const { client } = second;
        if (client === undefined) {
          throw new Error("sqlite driver must expose its client");
        }
        await client().unsafe("PRAGMA busy_timeout = 1000");

        let signalLockHeld!: () => void;
        const lockHeld = new Promise<void>((resolve) => {
          signalLockHeld = resolve;
        });
        const holding = first.transaction(async (tx) => {
          await tx`INSERT INTO migrations (migration, checksum) VALUES ('holding_row', NULL)`;
          signalLockHeld();
          await Bun.sleep(3000);
        });
        await lockHeld;

        const startedAt = Date.now();
        await expect(second.record("contending_row", "c".repeat(64))).rejects.toThrow();
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(700);

        await holding;
      } finally {
        await first.close();
        await second.close();
      }
    } finally {
      scenario.cleanup();
    }
  });
});

describe("concurrent up runs on a shared SQLite file", () => {
  function slowAuditMigration(listDir: string, file: string): void {
    writeFileSync(
      path.join(listDir, file),
      `const up = async (tx) => {
  await Bun.sleep(400);
  await tx.unsafe("CREATE TABLE audit (id INTEGER)");
  await tx.unsafe("INSERT INTO audit VALUES (1)");
};
const down = async (tx) => {
  await tx.unsafe("DROP TABLE IF EXISTS audit");
};
export { up, down };
`,
    );
  }

  it("serializes racing runs — one body execution, one record, all exit 0", async () => {
    const scenario = makeScenario("bunsql-sqlite-race-", "race.db");
    try {
      slowAuditMigration(scenario.listDir, "9_audit.js");
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };

      const results = await Promise.all(Array.from({ length: 4 }, () => runCli(["up"], env)));

      for (const result of results) {
        expect(result.exitCode).toBe(0);
        expect(result.output).not.toContain("database is locked");
      }
      expect(readRecorded(scenario.dbPath)).toEqual(["9_audit.js"]);
      expect(readRowCount(scenario.dbPath, "audit")).toBe(1);
      expect(existsSync(`${scenario.dbPath}.bunsql-migrate.lock`)).toBe(false);
    } finally {
      scenario.cleanup();
    }
  });

  it("serializes racing runs when the tracking table already exists", async () => {
    const scenario = makeScenario("bunsql-sqlite-race-", "race.db");
    try {
      slowAuditMigration(scenario.listDir, "9_audit.js");
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };
      expect((await runCli(["install"], env)).exitCode).toBe(0);

      const results = await Promise.all(Array.from({ length: 4 }, () => runCli(["up"], env)));

      for (const result of results) {
        expect(result.exitCode).toBe(0);
        expect(result.output).not.toContain("already exists");
        expect(result.output).not.toContain("database is locked");
      }
      expect(readRecorded(scenario.dbPath)).toEqual(["9_audit.js"]);
      expect(readRowCount(scenario.dbPath, "audit")).toBe(1);
    } finally {
      scenario.cleanup();
    }
  });

  it("fast-fails with the lock error while another run holds the lock", async () => {
    const scenario = makeScenario("bunsql-sqlite-race-", "race.db");
    try {
      slowAuditMigration(scenario.listDir, "9_audit.js");
      const holder = await createDriver(scenario.options.databaseUrl);
      try {
        const { tryLock, releaseLock } = holder;
        if (tryLock === undefined || releaseLock === undefined) {
          throw new Error("sqlite driver must support the lock interface");
        }
        await tryLock(30);

        const env = {
          ...process.env,
          DATABASE_URL: scenario.options.databaseUrl,
          MIGRATION_LIST_DIR: scenario.listDir,
        };
        const result = await runCli(["up", "--lock-timeout", "0"], env);
        expect(result.exitCode).toBe(4);
        expect(result.output).toContain("could not acquire the migration lock");

        await releaseLock();
      } finally {
        await holder.close();
      }

      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      };
      expect((await runCli(["up"], env)).exitCode).toBe(0);
      expect(readRecorded(scenario.dbPath)).toEqual(["9_audit.js"]);
    } finally {
      scenario.cleanup();
    }
  });
});
