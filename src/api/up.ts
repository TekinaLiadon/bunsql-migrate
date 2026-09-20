import path from "node:path";
import { checksumFile, listFiles, MIGRATION_EXTENSIONS, resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import { formatDuration } from "../core/duration.js";
import {
  type MigrateUpOptions,
  type MigrateUpResult,
  ChecksumDriftError,
  MigrationNotFoundError,
} from "./options.js";
import { runWithDriver } from "./run-with-driver.js";
import { runMigrationStep } from "./run-step.js";
import { loadMigration } from "./load-migration.js";
import { resolveLockTimeout, withMigrationLock } from "./lock.js";
import { ensureTrackingTable, listExecutedForPlan } from "./tracking-table.js";

export async function migrateUp(options: MigrateUpOptions = {}): Promise<MigrateUpResult> {
  const listDir = resolveListDir(options.listDir);
  const target = options.to;
  const dryRun = options.dryRun ?? false;
  const lockTimeout = resolveLockTimeout(options.lockTimeout);

  return runWithDriver(options, async (driver) => {
    if (!dryRun) {
      await ensureTrackingTable(driver);
    }

    const run = async (): Promise<MigrateUpResult> => {
      const allFiles = await listFiles(listDir, MIGRATION_EXTENSIONS);
      if (target !== undefined && !allFiles.includes(target)) {
        throw new MigrationNotFoundError(target);
      }

      const checksums = new Map(
        await Promise.all(
          allFiles.map(
            async (file) => [file, await checksumFile(path.join(listDir, file))] as const,
          ),
        ),
      );

      const executed = dryRun ? await listExecutedForPlan(driver) : await driver.listExecuted();
      const executedByName = new Map(executed.map((entry) => [entry.name, entry]));

      for (const [file, checksum] of checksums) {
        const record = executedByName.get(file);
        if (!record) continue;

        if (record.checksum === null) {
          if (!dryRun) {
            await driver.setChecksum(file, checksum);
            log({ text: `${file} checksum saved (legacy record)`, type: "info" });
          }
          continue;
        }

        if (record.checksum !== checksum) {
          throw new ChecksumDriftError(file);
        }
      }

      let pending = allFiles.filter((file) => !executedByName.has(file));
      if (target !== undefined) {
        if (executedByName.has(target)) {
          log({ text: `${target} is already applied.`, type: "info" });
          return dryRun ? { applied: [], planned: [] } : { applied: [] };
        }
        pending = pending.slice(0, pending.indexOf(target) + 1);
      }

      if (dryRun) {
        log({ text: "Dry run — no changes will be made.", type: "info" });
        if (pending.length === 0) {
          log({ text: "No pending migrations.", type: "warn" });
        }
        for (const file of pending) {
          log({ text: `${file} would be applied`, type: "info" });
        }
        return { applied: [], planned: pending };
      }

      const applied: string[] = [];

      if (pending.length === 0) {
        log({ text: "No pending migrations.", type: "warn" });
        return { applied };
      }

      for (const file of pending) {
        const checksum = checksums.get(file);
        if (!checksum) continue;
        try {
          const { up } = await loadMigration(listDir, file);
          if (up === null) {
            log({ text: `${file} has no up() export, skipping`, type: "warn" });
            continue;
          }
          const durationMs = await runMigrationStep(driver, up);
          await driver.record(file, checksum);
          applied.push(file);
          log({ text: `${file} migrated up (${formatDuration(durationMs)})`, type: "success" });
        } catch (error) {
          log({ text: `${file} migration failed`, type: "error", error });
          throw error;
        }
      }

      return { applied };
    };

    if (dryRun) {
      return run();
    }
    return withMigrationLock(driver, lockTimeout, run);
  });
}
