import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDriver, migrateUp } from "../src/index.js";

interface LockScenario {
  options: { databaseUrl: string; listDir: string };
  dbUrl: string;
  listDir: string;
  cleanup(): void;
}

function makeScenario(): LockScenario {
  const dir = mkdtempSync(path.join(tmpdir(), "bunsql-up-lock-"));
  const dbPath = path.join(dir, "lock.db");
  const listDir = path.join(dir, "list");
  mkdirSync(listDir, { recursive: true });
  return {
    options: { databaseUrl: `sqlite:${dbPath}`, listDir },
    dbUrl: `sqlite:${dbPath}`,
    listDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

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
    const scenario = makeScenario();
    try {
      const boomFile = "9_boom.js";
      const okFile = "1_ok.js";
      writeMigration(scenario.listDir, boomFile, failingMigrationFile("boom_table"));
      writeMigration(scenario.listDir, okFile, passingMigrationFile("ok_table"));

      await expect(migrateUp(scenario.options)).rejects.toThrow("migration-boom");
      expect(await readTables(scenario.dbUrl)).not.toContain("boom_table");

      unlinkSync(path.join(scenario.listDir, boomFile));
      const fixedFile = "8_boom_fixed.js";
      writeMigration(scenario.listDir, fixedFile, passingMigrationFile("boom_table"));
      const second = await migrateUp(scenario.options);
      expect(second.applied).toEqual([fixedFile, okFile]);
      expect(await readTables(scenario.dbUrl)).toEqual(
        expect.arrayContaining(["boom_table", "ok_table"]),
      );
    } finally {
      scenario.cleanup();
    }
  });

  it("validates lockTimeout before touching the database", async () => {
    const scenario = makeScenario();
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
    const scenario = makeScenario();
    try {
      const driver = await createDriver(scenario.dbUrl);
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

  it("makes a second connection wait for the file write lock up to the busy timeout", async () => {
    const scenario = makeScenario();
    try {
      const first = await createDriver(scenario.dbUrl);
      const second = await createDriver(scenario.dbUrl);
      try {
        await first.install();
        await second.install();

        const { tryLock: lockSecond } = second;
        if (lockSecond === undefined) {
          throw new Error("sqlite driver must support the lock interface");
        }
        await lockSecond(1);

        const holding = first.transaction(async (tx) => {
          await tx`INSERT INTO migrations (migration, checksum) VALUES ('holding_row', NULL)`;
          await Bun.sleep(1500);
        });
        await Bun.sleep(150);

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
