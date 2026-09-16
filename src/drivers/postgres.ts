import type { MigrationDriver } from "../core/driver.js";
import { createSqlDriver } from "./shared.js";

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
  });
}
