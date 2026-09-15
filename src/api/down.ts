import path from "node:path";
import { getDatabaseUrl } from "../core/env.js";
import { createDriver } from "../core/driver.js";
import { resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import type { MigrateDownResult, MigrateOptions } from "./options.js";

export async function migrateDown(options: MigrateOptions = {}): Promise<MigrateDownResult> {
  const url = getDatabaseUrl(options.databaseUrl);
  const listDir = resolveListDir(options.listDir);
  const driver = await createDriver(url);

  try {
    const executed = await driver.listExecuted();
    if (executed.length === 0) {
      log({ text: "No migrations to rollback.", type: "warn" });
      return { reverted: null };
    }

    const file = executed[executed.length - 1]!.name;
    const mod = await import(path.join(listDir, file));

    if (typeof mod.down !== "function") {
      log({ text: `${file} has no down() export, removing tracking record`, type: "warn" });
      await driver.remove(file);
      log({ text: `${file} tracking record removed`, type: "success" });
      return { reverted: file };
    }

    await mod.down();
    await driver.remove(file);
    log({ text: `${file} rolled back`, type: "success" });
    return { reverted: file };
  } finally {
    await driver.close();
  }
}
