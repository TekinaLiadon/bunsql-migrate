import { getDatabaseUrl } from "../core/env.js";
import { createDriver, type MigrationDriver } from "../core/driver.js";
import type { MigrateOptions } from "./options.js";

export async function runWithDriver<T>(
  options: MigrateOptions,
  run: (driver: MigrationDriver) => Promise<T>,
): Promise<T> {
  const url = getDatabaseUrl(options.databaseUrl);
  const driver = await createDriver(url, {
    ...(options.tableName !== undefined ? { tableName: options.tableName } : {}),
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
  });
  try {
    return await run(driver);
  } finally {
    await driver.close();
  }
}
