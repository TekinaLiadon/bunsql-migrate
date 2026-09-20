import { type SQL } from "bun";

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
      throw new Error(`Cannot parse database URL: ${databaseUrl}`);
    }
  }
  if (options.schema !== undefined && protocol !== "postgres" && protocol !== "postgresql") {
    throw new Error(
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
      throw new Error(
        `Unsupported database URL protocol: ${protocol}. Supported: postgres, mariadb/mysql, sqlite.`,
      );
  }
}
