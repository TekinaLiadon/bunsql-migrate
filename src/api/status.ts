import { listFiles, MIGRATION_EXTENSIONS, resolveListDir } from "../core/fs.js";
import type { MigrateOptions, MigrateStatusResult } from "./options.js";
import { runWithDriver } from "./run-with-driver.js";
import { ensureTrackingTable } from "./tracking-table.js";

export async function migrateStatus(options: MigrateOptions = {}): Promise<MigrateStatusResult> {
  const listDir = resolveListDir(options.listDir);

  return runWithDriver(options, async (driver) => {
    await ensureTrackingTable(driver);

    const files = await listFiles(listDir, MIGRATION_EXTENSIONS);
    const executed = await driver.listExecuted();
    const appliedNames = new Set(executed.map((entry) => entry.name));

    return {
      applied: executed,
      pending: files.filter((file) => !appliedNames.has(file)),
    };
  });
}
