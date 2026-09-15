import { SQL } from "bun";
import type { ExecutedMigration, MigrationDriver } from "../core/driver.js";

export function create(databaseUrl: string): MigrationDriver {
  const db = new SQL(databaseUrl);

  return {
    async install() {
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

    async listExecuted() {
      const rows = await db`SELECT migration, checksum FROM migrations ORDER BY id ASC`;
      return rows.map(
        (r: { migration: string; checksum: string | null }): ExecutedMigration => ({
          name: r.migration,
          checksum: r.checksum ?? null,
        }),
      );
    },

    async record(migration: string, checksum: string) {
      await db`INSERT OR IGNORE INTO migrations (migration, checksum)
        VALUES (${migration}, ${checksum})`;
    },

    async setChecksum(migration: string, checksum: string) {
      await db`UPDATE migrations SET checksum = ${checksum} WHERE migration = ${migration}`;
    },

    async remove(migration: string) {
      await db`DELETE FROM migrations WHERE migration = ${migration}`;
    },

    async close() {
      db.close({ timeout: 0 });
    },
  };
}
