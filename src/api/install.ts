import { log } from "../core/console.js";
import type { MigrateOptions } from "./options.js";
import { runWithDriver } from "./run-with-driver.js";

export async function installMigrations(options: MigrateOptions = {}): Promise<void> {
  await runWithDriver(options, async (driver) => {
    await driver.install();
    log({ text: "Migration table created!", type: "success" });
  });
}
