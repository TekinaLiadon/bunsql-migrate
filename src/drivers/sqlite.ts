import type { MigrationDriver } from "../core/driver.js";
import { createSqlDriver } from "./shared.js";

export function create(databaseUrl: string): MigrationDriver {
  return createSqlDriver(databaseUrl, {
    async install(db) {
      await db`CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        migration TEXT NOT NULL,
        checksum TEXT
      )`;
      const columns = (await db`PRAGMA table_info(migrations)`) as Array<{
        name: string;
      }>;
      const hasChecksum = columns.some((column) => column.name === "checksum");
      if (!hasChecksum) {
        await db`ALTER TABLE migrations ADD COLUMN checksum TEXT`;
      }
      await db`CREATE UNIQUE INDEX IF NOT EXISTS migrations_migration_unique ON migrations (migration)`;
    },
    async record(db, migration, checksum) {
      await db`INSERT OR IGNORE INTO migrations (migration, checksum)
        VALUES (${migration}, ${checksum})`;
    },
  });
}
