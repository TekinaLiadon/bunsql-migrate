import type { DriverTableOptions, MigrationDriver } from "../core/driver.js";
import { doubleQuoted, validateIdentifier } from "../core/identifiers.js";
import { createSqlDriver } from "./shared.js";

const TABLE_NAME_MAX_LENGTH = 128;
const UNIQUE_INDEX_SUFFIX = "_migration_unique";

function resolveTableRef(options: DriverTableOptions): {
  table: string;
  index: string;
  name: string;
} {
  const tableName = options.tableName ?? "migrations";
  validateIdentifier("table", tableName, TABLE_NAME_MAX_LENGTH);
  return {
    table: doubleQuoted(tableName),
    index: doubleQuoted(`${tableName}${UNIQUE_INDEX_SUFFIX}`),
    name: tableName,
  };
}

export function create(databaseUrl: string, options: DriverTableOptions = {}): MigrationDriver {
  const { table, index, name } = resolveTableRef(options);
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
      createLock: (db) => ({
        async tryLock(timeoutSeconds: number) {
          await db.unsafe(`PRAGMA busy_timeout = ${timeoutSeconds * 1000}`);
          return true;
        },
        async releaseLock() {
          await db.unsafe("PRAGMA busy_timeout = 0");
        },
        dispose() {},
      }),
    },
    table,
  );
}
