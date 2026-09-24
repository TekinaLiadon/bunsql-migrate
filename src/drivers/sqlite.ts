import type { DriverTableOptions, MigrationDriver } from "../core/driver.js";
import { doubleQuoted } from "../core/identifiers.js";
import { createSqlDriver, resolveTableRef, UNIQUE_INDEX_SUFFIX } from "./shared.js";
import { createInMemoryLock, createSqliteFileLock, sqliteLockPath } from "./sqlite-lock.js";

const TABLE_NAME_MAX_LENGTH = 128;

export const DEFAULT_BUSY_TIMEOUT_MS = 30_000;

export async function create(
  databaseUrl: string,
  options: DriverTableOptions = {},
): Promise<MigrationDriver> {
  const { table, index, name } = resolveTableRef(options, {
    quote: doubleQuoted,
    maxLength: TABLE_NAME_MAX_LENGTH,
  });
  return createSqlDriver(
    databaseUrl,
    {
      async install(db) {
        await db`CREATE TABLE IF NOT EXISTS ${db.unsafe(table)} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          migration TEXT NOT NULL,
          checksum TEXT
        )`;
        const columns = (await db.unsafe(`PRAGMA table_info(${table})`)) as Array<{
          name: string;
        }>;
        const hasChecksum = columns.some((column) => column.name === "checksum");
        if (!hasChecksum) {
          await db`ALTER TABLE ${db.unsafe(table)} ADD COLUMN checksum TEXT`;
        }
        await db`CREATE UNIQUE INDEX IF NOT EXISTS ${db.unsafe(index)} ON ${db.unsafe(table)} (migration)`;
      },
      async trackingTableExists(db) {
        const rows = await db`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
        return rows.length > 0;
      },
      async trackingTableCurrent(db) {
        const columns = (await db.unsafe(`PRAGMA table_info(${table})`)) as Array<{
          name: string;
        }>;
        if (!columns.some((column) => column.name === "checksum")) return false;
        const indexName = `${name}${UNIQUE_INDEX_SUFFIX}`;
        const indexes = (await db`SELECT 1 FROM sqlite_master WHERE type = 'index'
          AND name = ${indexName}`) as Array<unknown>;
        return indexes.length > 0;
      },
      async record(db, migration, checksum) {
        await db`INSERT OR IGNORE INTO ${db.unsafe(table)} (migration, checksum)
          VALUES (${migration}, ${checksum})`;
      },
      async setupConnection(db) {
        await db.unsafe(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
      },
      createLock: (_db) => {
        const lockPath = sqliteLockPath(databaseUrl);
        if (lockPath === null) {
          return createInMemoryLock();
        }
        const fileLock = createSqliteFileLock(lockPath);
        return {
          async tryLock(timeoutSeconds: number) {
            return fileLock.tryLock(timeoutSeconds);
          },
          async releaseLock() {
            await fileLock.releaseLock();
          },
          async dispose() {
            await fileLock.dispose();
          },
        };
      },
    },
    table,
  );
}
