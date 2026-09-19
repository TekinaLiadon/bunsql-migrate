import { type SQL } from "bun";
import type { DriverTableOptions, MigrationDriver } from "../core/driver.js";
import { doubleQuoted, validateIdentifier } from "../core/identifiers.js";
import { createReservedLock, createSqlDriver } from "./shared.js";

const LOCK_SCOPE = "bunsql-native-migrate:up";

const IDENTIFIER_MAX_LENGTH = 63;
const UNIQUE_INDEX_SUFFIX = "_migration_unique";

interface TableRef {
  table: string;
  index: string;
  name: string;
  schemaName?: string;
}

function resolveTableRef(options: DriverTableOptions): TableRef {
  const tableName = options.tableName ?? "migrations";
  validateIdentifier("table", tableName, IDENTIFIER_MAX_LENGTH);
  const index = doubleQuoted(`${tableName}${UNIQUE_INDEX_SUFFIX}`);
  if (options.schema === undefined) {
    return { table: doubleQuoted(tableName), index, name: tableName };
  }
  validateIdentifier("schema", options.schema, IDENTIFIER_MAX_LENGTH);
  return {
    table: `${doubleQuoted(options.schema)}.${doubleQuoted(tableName)}`,
    index,
    name: tableName,
    schemaName: options.schema,
  };
}

async function advisoryKeyComponents(lock: SQL): Promise<[number, number]> {
  const rows = (await lock`SELECT current_database() AS name`) as Array<{ name: string }>;
  const hash = Bun.hash.wyhash(`${LOCK_SCOPE}:${rows[0]?.name ?? ""}`);
  return [Number((hash >> 32n) & 0x7fffffffn), Number(hash & 0x7fffffffn)];
}

export function create(databaseUrl: string, options: DriverTableOptions = {}): MigrationDriver {
  const { table, index, name, schemaName } = resolveTableRef(options);
  return createSqlDriver(
    databaseUrl,
    {
      async install(db) {
        await db`CREATE TABLE IF NOT EXISTS ${db.unsafe(table)} (
          id SERIAL PRIMARY KEY,
          migration VARCHAR(255) NOT NULL,
          checksum VARCHAR(64)
        )`;
        await db`ALTER TABLE ${db.unsafe(table)} ADD COLUMN IF NOT EXISTS checksum VARCHAR(64)`;
        await db`CREATE UNIQUE INDEX IF NOT EXISTS ${db.unsafe(index)} ON ${db.unsafe(table)} (migration)`;
      },
      async trackingTableExists(db) {
        const rows = schemaName
          ? await db`SELECT 1 FROM information_schema.tables
              WHERE table_schema = ${schemaName} AND table_name = ${name}`
          : await db`SELECT 1 FROM information_schema.tables
              WHERE table_schema = current_schema() AND table_name = ${name}`;
        return rows.length > 0;
      },
      async record(db, migration, checksum) {
        await db`INSERT INTO ${db.unsafe(table)} (migration, checksum)
          VALUES (${migration}, ${checksum})
          ON CONFLICT (migration) DO NOTHING`;
      },
      createLock: (db) =>
        createReservedLock(
          db,
          async (lock) => {
            const [first, second] = await advisoryKeyComponents(lock);
            const rows =
              (await lock`SELECT pg_try_advisory_lock(${first}, ${second}) AS locked`) as Array<{
                locked: boolean;
              }>;
            return rows[0]?.locked === true;
          },
          async (lock) => {
            const [first, second] = await advisoryKeyComponents(lock);
            await lock`SELECT pg_advisory_unlock(${first}, ${second})`;
          },
        ),
    },
    table,
  );
}
