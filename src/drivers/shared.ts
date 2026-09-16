import { SQL } from "bun";
import type { ExecutedMigration, MigrationDriver } from "../core/driver.js";

export interface SqlDialect {
  install(db: SQL): Promise<void>;
  record(db: SQL, migration: string, checksum: string): Promise<void>;
}

export function createSqlDriver(databaseUrl: string, dialect: SqlDialect): MigrationDriver {
  const db = new SQL(databaseUrl);

  return {
    install: () => dialect.install(db),
    async listExecuted() {
      const rows = await db`SELECT migration, checksum FROM migrations ORDER BY id ASC`;
      return rows.map(
        (r: { migration: string; checksum: string | null }): ExecutedMigration => ({
          name: r.migration,
          checksum: r.checksum ?? null,
        }),
      );
    },
    record: (migration, checksum) => dialect.record(db, migration, checksum),
    async setChecksum(migration, checksum) {
      await db`UPDATE migrations SET checksum = ${checksum} WHERE migration = ${migration}`;
    },
    async remove(migration) {
      await db`DELETE FROM migrations WHERE migration = ${migration}`;
    },
    transaction: (run) => db.begin(run),
    async close() {
      db.close({ timeout: 0 });
    },
  };
}
