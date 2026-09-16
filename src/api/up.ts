import path from "node:path";
import { checksumFile, listFiles, resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import { type MigrateOptions, type MigrateUpResult, ChecksumDriftError } from "./options.js";
import { runWithDriver } from "./run-with-driver.js";
import { runMigrationStep } from "./run-step.js";

export async function migrateUp(options: MigrateOptions = {}): Promise<MigrateUpResult> {
  const listDir = resolveListDir(options.listDir);

  return runWithDriver(options, async (driver) => {
    await driver.install();

    const allFiles = await listFiles(listDir, "js");
    const checksums = new Map(
      await Promise.all(
        allFiles.map(async (file) => [file, await checksumFile(path.join(listDir, file))] as const),
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

    const pending = allFiles.filter((file) => !executedByName.has(file));
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
}
