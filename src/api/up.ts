import path from "node:path";
import { checksumFile, listFiles, MIGRATION_EXTENSIONS, resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import {
  type MigrateUpOptions,
  type MigrateUpResult,
  ChecksumDriftError,
  MigrationNotFoundError,
} from "./options.js";
import { runWithDriver } from "./run-with-driver.js";
import { runMigrationStep } from "./run-step.js";
import { resolveLockTimeout, withMigrationLock } from "./lock.js";

export async function migrateUp(options: MigrateUpOptions = {}): Promise<MigrateUpResult> {
  const listDir = resolveListDir(options.listDir);
  const target = options.to;
  const lockTimeout = resolveLockTimeout(options.lockTimeout);

  return runWithDriver(options, async (driver) => {
    await driver.install();

    return withMigrationLock(driver, lockTimeout, async () => {
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

      const executed = await driver.listExecuted();
      const executedByName = new Map(executed.map((entry) => [entry.name, entry]));

      for (const [file, checksum] of checksums) {
        const record = executedByName.get(file);
        if (!record) continue;

        if (record.checksum === null) {
          await driver.setChecksum(file, checksum);
          log({ text: `${file} checksum saved (legacy record)`, type: "info" });
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
          return { applied: [] };
        }
        pending = pending.slice(0, pending.indexOf(target) + 1);
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
          const mod = await import(path.join(listDir, file));
          if (typeof mod.up !== "function") {
            log({ text: `${file} has no up() export, skipping`, type: "warn" });
            continue;
          }
          await runMigrationStep(driver, mod.up);
          await driver.record(file, checksum);
          applied.push(file);
          log({ text: `${file} migrated up`, type: "success" });
        } catch (error) {
          log({ text: `${file} migration failed`, type: "error", error });
          throw error;
        }
      }

      return { applied };
    });
  });
}
