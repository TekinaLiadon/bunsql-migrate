import { type SQL } from "bun";
import { BunsqlMigrateError } from "./error.js";

export interface ExecutedMigration {
  name: string;
  checksum: string | null;
}

export interface MigrationDriver {
  install(): Promise<void>;
  listExecuted(): Promise<ExecutedMigration[]>;
  record(migration: string, checksum: string): Promise<void>;
  setChecksum(migration: string, checksum: string): Promise<void>;
  remove(migration: string): Promise<void>;
  transaction<T>(run: (tx: SQL) => Promise<T>): Promise<T>;
  trackingTableExists?(): Promise<boolean>;
  trackingTableCurrent?(): Promise<boolean>;
  tryLock?(timeoutSeconds: number): Promise<boolean>;
  releaseLock?(): Promise<void>;
  close(): Promise<void>;
  client?(): SQL;
}

export interface DriverTableOptions {
  tableName?: string;
  schema?: string;
}

const URL_PASSWORD_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@/?#]*:)[^/?#]*@/;
const URL_USERINFO_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[\s\S]*@/;

export function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password !== "") {
      url.password = "***";
    }
    return url.href;
  } catch {
    const maskedPassword = databaseUrl.replace(URL_PASSWORD_PATTERN, "$1***@");
    if (maskedPassword !== databaseUrl) {
      return maskedPassword;
    }
    return databaseUrl.replace(URL_USERINFO_PATTERN, "$1***@");
  }
}

export async function createDriver(
  databaseUrl: string,
  options: DriverTableOptions = {},
): Promise<MigrationDriver> {
  let protocol: string;
  try {
    protocol = new URL(databaseUrl).protocol.replace(":", "");
  } catch {
    if (databaseUrl.startsWith("sqlite:")) {
      protocol = "sqlite";
    } else {
      throw new BunsqlMigrateError(
        "usage",
        `Cannot parse database URL: ${redactDatabaseUrl(databaseUrl)}`,
      );
    }
  }
  if (options.schema !== undefined && protocol !== "postgres" && protocol !== "postgresql") {
    throw new BunsqlMigrateError(
      "usage",
      "The schema option is only supported for postgres URLs — MySQL/MariaDB selects the database in the URL, SQLite has no schemas",
    );
  }
  switch (protocol) {
    case "postgres":
    case "postgresql": {
      const mod = await import("./../drivers/postgres.js");
      return mod.create(databaseUrl, options);
    }
    case "sqlite": {
      const mod = await import("./../drivers/sqlite.js");
      return mod.create(databaseUrl, options);
    }
    case "mariadb":
    case "mysql": {
      const mod = await import("./../drivers/mariadb.js");
      return mod.create(databaseUrl, options);
    }
    default:
      throw new BunsqlMigrateError(
        "usage",
        `Unsupported database URL protocol: ${protocol}. Supported: postgres, mariadb/mysql, sqlite.`,
      );
  }
}
