import { SQL, type ReservedSQL } from "bun";
import type { ExecutedMigration, MigrationDriver } from "../core/driver.js";

export interface SqlLock {
  tryLock(timeoutSeconds: number): Promise<boolean>;
  releaseLock(): Promise<void>;
  dispose(): void;
}

export interface SqlDialect {
  install(db: SQL): Promise<void>;
  record(db: SQL, migration: string, checksum: string): Promise<void>;
  trackingTableExists?(db: SQL): Promise<boolean>;
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
