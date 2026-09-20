import { type SQL } from "bun";
import type { DriverTableOptions, MigrationDriver } from "../core/driver.js";
import { backtickQuoted, validateIdentifier } from "../core/identifiers.js";
import { createReservedLock, createSqlDriver } from "./shared.js";

const LOCK_NAME_PREFIX = "bunsql-native-migrate:";

const TABLE_NAME_MAX_LENGTH = 47;
const UNIQUE_INDEX_SUFFIX = "_migration_unique";

function resolveTableRef(options: DriverTableOptions): {
  table: string;
  index: string;
  name: string;
} {
  const tableName = options.tableName ?? "migrations";
  validateIdentifier("table", tableName, TABLE_NAME_MAX_LENGTH);
  return {
    table: backtickQuoted(tableName),
    index: backtickQuoted(`${tableName}${UNIQUE_INDEX_SUFFIX}`),
    name: tableName,
  };
}

async function checksumColumnExists(db: SQL, tableName: string): Promise<boolean> {
  const rows = await db`SELECT column_name FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = ${tableName}
      AND column_name = 'checksum'`;
  return rows.length > 0;
}

async function uniqueIndexExists(db: SQL, tableName: string): Promise<boolean> {
  const rows = await db`SELECT index_name FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = ${tableName}
      AND index_name = ${`${tableName}${UNIQUE_INDEX_SUFFIX}`}`;
  return rows.length > 0;
}

export function create(databaseUrl: string, options: DriverTableOptions = {}): MigrationDriver {
  const { table, index, name } = resolveTableRef(options);
  return createSqlDriver(
    databaseUrl,
    {
      async install(db) {
        await db`CREATE TABLE IF NOT EXISTS ${db.unsafe(table)} (
          id INTEGER PRIMARY KEY AUTO_INCREMENT,
          migration VARCHAR(255) NOT NULL,
          checksum VARCHAR(64),
          CONSTRAINT ${db.unsafe(index)} UNIQUE (migration)
        )`;
        if (!(await checksumColumnExists(db, name))) {
          await db`ALTER TABLE ${db.unsafe(table)} ADD COLUMN checksum VARCHAR(64)`;
        }
        if (!(await uniqueIndexExists(db, name))) {
          await db`CREATE UNIQUE INDEX ${db.unsafe(index)} ON ${db.unsafe(table)} (migration)`;
        }
      },
      async trackingTableExists(db) {
        const rows = await db`SELECT 1 FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_name = ${name}`;
        return rows.length > 0;
      },
      async trackingTableCurrent(db) {
        const rows = (await db`SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_name = ${name}
          ) AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = ${name} AND column_name = 'checksum'
          ) AND EXISTS (
            SELECT 1 FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = ${name}
              AND index_name = ${`${name}${UNIQUE_INDEX_SUFFIX}`}
          ) AS current`) as Array<{ current: number | boolean }>;
        const current = rows[0]?.current;
        return current === 1 || current === true;
      },
      async record(db, migration, checksum) {
        await db`INSERT IGNORE INTO ${db.unsafe(table)} (migration, checksum)
          VALUES (${migration}, ${checksum})`;
      },
      createLock: (db) =>
        createReservedLock(
          db,
          async (lock) => {
            const rows =
              (await lock`SELECT GET_LOCK(CONCAT(${LOCK_NAME_PREFIX}, MD5(DATABASE())), 0) AS locked`) as Array<{
                locked: number | string | null;
              }>;
            const locked = rows[0]?.locked;
            return locked === 1 || locked === "1";
          },
          async (lock) => {
            await lock`SELECT RELEASE_LOCK(CONCAT(${LOCK_NAME_PREFIX}, MD5(DATABASE())))`;
          },
        ),
    },
    table,
  );
}
