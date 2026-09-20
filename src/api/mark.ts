import path from "node:path";
import { checksumFile, listFiles, MIGRATION_EXTENSIONS, resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import { type MarkOptions, type MarkResult } from "./options.js";
import { resolvePendingToTarget } from "./pending.js";
import { runWithDriver } from "./run-with-driver.js";
import { ensureTrackingTable } from "./tracking-table.js";

export async function markMigrationsApplied(options: MarkOptions = {}): Promise<MarkResult> {
  const listDir = resolveListDir(options.listDir);
  const target = options.to;

  return runWithDriver(options, async (driver) => {
    await ensureTrackingTable(driver);

    const allFiles = await listFiles(listDir, MIGRATION_EXTENSIONS);
    const executed = await driver.listExecuted();

    const { pending, targetApplied } = resolvePendingToTarget({
      allFiles,
      executedNames: executed.map((entry) => entry.name),
      target,
    });
    if (targetApplied) {
      return { marked: [] };
    }

    const checksums = new Map(
      await Promise.all(
        pending.map(async (file) => [file, await checksumFile(path.join(listDir, file))] as const),
      ),
    );

    const marked: string[] = [];
    for (const file of pending) {
      const checksum = checksums.get(file);
      if (!checksum) continue;
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
