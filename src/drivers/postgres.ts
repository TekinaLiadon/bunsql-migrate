import { type SQL } from "bun";
import type { MigrationDriver } from "../core/driver.js";
import { createReservedLock, createSqlDriver } from "./shared.js";

const LOCK_SCOPE = "bunsql-native-migrate:up";

async function advisoryKeyComponents(lock: SQL): Promise<[number, number]> {
  const rows = (await lock`SELECT current_database() AS name`) as Array<{ name: string }>;
  const hash = Bun.hash.wyhash(`${LOCK_SCOPE}:${rows[0]?.name ?? ""}`);
  return [Number((hash >> 32n) & 0x7fffffffn), Number(hash & 0x7fffffffn)];
}

export function create(databaseUrl: string): MigrationDriver {
  return createSqlDriver(databaseUrl, {
    async install(db) {
      await db`CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        migration VARCHAR(255) NOT NULL,
        checksum VARCHAR(64)
      )`;
      await db`ALTER TABLE migrations ADD COLUMN IF NOT EXISTS checksum VARCHAR(64)`;
      await db`CREATE UNIQUE INDEX IF NOT EXISTS migrations_migration_unique ON migrations (migration)`;
    },
    async record(db, migration, checksum) {
      await db`INSERT INTO migrations (migration, checksum)
        VALUES (${migration}, ${checksum})
        ON CONFLICT (migration) DO NOTHING`;
    },
    createLock: (db) =>
      createReservedLock(
        db,
        async (lock) => {
          const [first, second] = await advisoryKeyComponents(lock);
          const rows =
            (await lock`SELECT pg_try_advisory_lock(${first}, ${second}) AS locked`) as Array<{
              locked: boolean;
            }>;
          return rows[0]?.locked === true;
        },
        async (lock) => {
          const [first, second] = await advisoryKeyComponents(lock);
          await lock`SELECT pg_advisory_unlock(${first}, ${second})`;
        },
      ),
  });
}
