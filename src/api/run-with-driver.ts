import { getDatabaseUrl } from "../core/env.js";
import { log } from "../core/console.js";
import type { MigrationDriver } from "../core/driver.js";
import type { MigrateOptions } from "./options.js";
import { connectDriver, resolveWaitTimeout } from "./wait.js";

export async function runWithDriver<T>(
  options: MigrateOptions,
  run: (driver: MigrationDriver) => Promise<T>,
): Promise<T> {
  const url = getDatabaseUrl(options.databaseUrl);
  const driver = await connectDriver(
    url,
    {
      ...(options.tableName !== undefined ? { tableName: options.tableName } : {}),
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
    },
    resolveWaitTimeout(options.waitTimeout),
  );
  try {
    const result = await run(driver);
    await driver.close();
    return result;
  } catch (error) {
    await driver.close().catch(() => {
      log({
        text: "failed to close the database connection after the failed run",
        type: "warn",
      });
    });
    throw error;
  }
}
