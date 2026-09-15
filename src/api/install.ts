import { getDatabaseUrl } from "../core/env.js";
import { createDriver } from "../core/driver.js";
import { log } from "../core/console.js";
import type { MigrateOptions } from "./options.js";

export async function installMigrations(options: MigrateOptions = {}): Promise<void> {
  const url = getDatabaseUrl(options.databaseUrl);
  const driver = await createDriver(url);
  try {
    await driver.install();
    log({ text: "Migration table created!", type: "success" });
  } finally {
    await driver.close();
  }
}
