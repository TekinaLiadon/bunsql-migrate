import { type SQL } from "bun";
import type { MigrationDriver } from "../core/driver.js";
import { createReservedLock, createSqlDriver } from "./shared.js";

const LOCK_NAME_PREFIX = "bunsql-native-migrate:";

async function checksumColumnExists(db: SQL): Promise<boolean> {
  const rows = await db`SELECT column_name FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'migrations'
      AND column_name = 'checksum'`;
  return rows.length > 0;
}

async function uniqueIndexExists(db: SQL): Promise<boolean> {
  const rows = await db`SELECT index_name FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'migrations'
      AND index_name = 'migrations_migration_unique'`;
  return rows.length > 0;
}

export function create(databaseUrl: string): MigrationDriver {
  return createSqlDriver(databaseUrl, {
    async install(db) {
      await db`CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTO_INCREMENT,
        migration VARCHAR(255) NOT NULL,
        checksum VARCHAR(64),
        CONSTRAINT migrations_migration_unique UNIQUE (migration)
      )`;
      if (!(await checksumColumnExists(db))) {
        await db`ALTER TABLE migrations ADD COLUMN checksum VARCHAR(64)`;
      }
      if (!(await uniqueIndexExists(db))) {
        await db`CREATE UNIQUE INDEX migrations_migration_unique ON migrations (migration)`;
      }
    },
    async record(db, migration, checksum) {
      await db`INSERT IGNORE INTO migrations (migration, checksum)
        VALUES (${migration}, ${checksum})`;
    },
    createLock: (db) =>
      createReservedLock(
        db,
        async (lock) => {
          const rows =
            (await lock`SELECT GET_LOCK(CONCAT(${LOCK_NAME_PREFIX}, MD5(DATABASE())), 0) AS locked`) as Array<{
              locked: number | string | null;
            }>;
          const locked = rows[0]?.locked;
          return locked === 1 || locked === "1";
        },
        async (lock) => {
          await lock`SELECT RELEASE_LOCK(CONCAT(${LOCK_NAME_PREFIX}, MD5(DATABASE())))`;
        },
      ),
  });
}
