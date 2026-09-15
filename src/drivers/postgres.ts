import { SQL } from "bun";
import type { ExecutedMigration, MigrationDriver } from "../core/driver.js";

export function create(databaseUrl: string): MigrationDriver {
  const db = new SQL(databaseUrl);

  return {
    async install() {
      await db`CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        migration VARCHAR(255) NOT NULL,
        checksum VARCHAR(64)
      )`;
      await db`ALTER TABLE migrations ADD COLUMN IF NOT EXISTS checksum VARCHAR(64)`;
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
      await db`INSERT INTO migrations (migration, checksum)
        VALUES (${migration}, ${checksum})
        ON CONFLICT (migration) DO NOTHING`;
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
