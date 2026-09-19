import path from "node:path";
import { checksumFile, listFiles, MIGRATION_EXTENSIONS, resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import { type MarkOptions, type MarkResult, MigrationNotFoundError } from "./options.js";
import { runWithDriver } from "./run-with-driver.js";

export async function markMigrationsApplied(options: MarkOptions = {}): Promise<MarkResult> {
  const listDir = resolveListDir(options.listDir);
  const target = options.to;

  return runWithDriver(options, async (driver) => {
    await driver.install();

    const allFiles = await listFiles(listDir, MIGRATION_EXTENSIONS);
    if (target !== undefined && !allFiles.includes(target)) {
      throw new MigrationNotFoundError(target);
    }

    const executed = await driver.listExecuted();
    const executedNames = new Set(executed.map((entry) => entry.name));
    let pending = allFiles.filter((file) => !executedNames.has(file));
    if (target !== undefined) {
      if (executedNames.has(target)) {
        log({ text: `${target} is already applied.`, type: "info" });
        return { marked: [] };
      }
      pending = pending.slice(0, pending.indexOf(target) + 1);
    }

    const marked: string[] = [];
    for (const file of pending) {
      const checksum = await checksumFile(path.join(listDir, file));
      await driver.record(file, checksum);
      marked.push(file);
      log({ text: `${file} marked as applied`, type: "success" });
    }
    if (marked.length === 0) {
      log({ text: "No pending migrations to mark.", type: "warn" });
    }

    return { marked };
  });
}
