import { SQL, type ReservedSQL } from "bun";
import type { DriverTableOptions, ExecutedMigration, MigrationDriver } from "../core/driver.js";
import { validateIdentifier } from "../core/identifiers.js";

export const UNIQUE_INDEX_SUFFIX = "_migration_unique";

export interface TableRef {
  table: string;
  index: string;
  name: string;
}

interface TableRefSpec {
  quote: (identifier: string) => string;
  maxLength: number;
}

export function resolveTableRef(options: DriverTableOptions, spec: TableRefSpec): TableRef {
  const tableName = options.tableName ?? "migrations";
  validateIdentifier("table", tableName, spec.maxLength);
  return {
    table: spec.quote(tableName),
    index: spec.quote(`${tableName}${UNIQUE_INDEX_SUFFIX}`),
    name: tableName,
  };
}

export interface SqlLock {
  tryLock(timeoutSeconds: number): Promise<boolean>;
  releaseLock(): Promise<void>;
  dispose(): void;
}

export interface SqlDialect {
  install(db: SQL): Promise<void>;
  record(db: SQL, migration: string, checksum: string): Promise<void>;
  trackingTableExists?(db: SQL): Promise<boolean>;
  trackingTableCurrent?(db: SQL): Promise<boolean>;
  createLock?(db: SQL): SqlLock;
}

export function createReservedLock(
  db: SQL,
  acquire: (lock: SQL) => Promise<boolean>,
  release: (lock: SQL) => Promise<void>,
): SqlLock {
  let lockConnection: ReservedSQL | null = null;

  return {
    async tryLock() {
      const connection = await db.reserve();
      lockConnection = connection;
      try {
        const acquired = await acquire(connection);
        if (!acquired) {
          connection.release();
          lockConnection = null;
        }
        return acquired;
      } catch (error) {
        connection.release();
        lockConnection = null;
        throw error;
      }
    },
    async releaseLock() {
      const connection = lockConnection;
      if (!connection) return;
      lockConnection = null;
      try {
        await release(connection);
      } finally {
        connection.release();
      }
    },
    dispose() {
      lockConnection?.release();
      lockConnection = null;
    },
  };
}

export function createSqlDriver(
  databaseUrl: string,
  dialect: SqlDialect,
  table: string,
): MigrationDriver {
  const db = new SQL(databaseUrl);
  const lock = dialect.createLock?.(db);

  return {
    install: () => dialect.install(db),
    async listExecuted() {
      const rows = await db`SELECT migration, checksum FROM ${db.unsafe(table)} ORDER BY id ASC`;
      return rows.map(
        (r: { migration: string; checksum: string | null }): ExecutedMigration => ({
          name: r.migration,
          checksum: r.checksum ?? null,
        }),
      );
    },
    record: (migration, checksum) => dialect.record(db, migration, checksum),
    async setChecksum(migration, checksum) {
      await db`UPDATE ${db.unsafe(table)} SET checksum = ${checksum} WHERE migration = ${migration}`;
    },
    async remove(migration) {
      await db`DELETE FROM ${db.unsafe(table)} WHERE migration = ${migration}`;
    },
    transaction: (run) => db.begin(run),
    ...(dialect.trackingTableExists
      ? { trackingTableExists: () => dialect.trackingTableExists!(db) }
      : {}),
    ...(dialect.trackingTableCurrent
      ? { trackingTableCurrent: () => dialect.trackingTableCurrent!(db) }
      : {}),
    ...(lock
      ? {
          tryLock: (timeoutSeconds: number) => lock.tryLock(timeoutSeconds),
          releaseLock: () => lock.releaseLock(),
        }
      : {}),
    async close() {
      lock?.dispose();
      db.close({ timeout: 0 });
    },
  };
}
