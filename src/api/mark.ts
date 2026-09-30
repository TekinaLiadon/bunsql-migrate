import { checksumFiles, listMigrationFiles, requireChecksum, resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import { type MarkOptions, type MarkResult } from "./options.js";
import { assertTargetOptions, resolvePendingToTarget } from "./pending.js";
import { runWithDriver } from "./run-with-driver.js";
import { ensureTrackingTable } from "./tracking-table.js";

export async function markMigrationsApplied(options: MarkOptions = {}): Promise<MarkResult> {
  const listDir = resolveListDir(options.listDir);
  const target = options.to;

  await assertTargetOptions("mark", listDir, target, undefined);

  return runWithDriver(options, async (driver) => {
    await ensureTrackingTable(driver);

    const allFiles = await listMigrationFiles(listDir);
    const executed = await driver.listExecuted();

    const { pending, targetApplied } = resolvePendingToTarget({
      allFiles,
      executedNames: executed.map((entry) => entry.name),
      target,
    });
    if (targetApplied) {
      return { marked: [] };
    }

    const checksums = await checksumFiles(listDir, pending);

    const marked: string[] = [];
    for (const file of pending) {
      const checksum = requireChecksum(checksums, file);
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
