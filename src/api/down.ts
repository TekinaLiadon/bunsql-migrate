import { resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import { formatDuration } from "../core/duration.js";
import type { MigrationDriver } from "../core/driver.js";
import type { MigrateDownOptions, MigrateDownResult } from "./options.js";
import { runWithDriver } from "./run-with-driver.js";
import { runMigrationStep } from "./run-step.js";
import { isSqlMigration, loadMigration } from "./load-migration.js";

function resolveStepCount(steps: number | "all" | undefined, appliedCount: number): number {
  if (steps === undefined) return 1;
  if (steps === "all") return appliedCount;
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error(`Invalid steps: ${String(steps)} — expected a positive integer or "all"`);
  }
  return steps;
}

async function revertOne(driver: MigrationDriver, listDir: string, file: string): Promise<void> {
  const { down } = await loadMigration(listDir, file);

  if (down === null) {
    const reason = isSqlMigration(file) ? "has no .down.sql pair" : "has no down() export";
    log({ text: `${file} ${reason}, removing tracking record`, type: "warn" });
    await driver.remove(file);
    log({ text: `${file} tracking record removed`, type: "success" });
    return;
  }

  const durationMs = await runMigrationStep(driver, down);
  await driver.remove(file);
  log({ text: `${file} rolled back (${formatDuration(durationMs)})`, type: "success" });
}

export async function migrateDown(options: MigrateDownOptions = {}): Promise<MigrateDownResult> {
  const listDir = resolveListDir(options.listDir);
  const dryRun = options.dryRun ?? false;

  return runWithDriver(options, async (driver) => {
    const executed = await driver.listExecuted();
    if (executed.length === 0) {
      log({ text: "No migrations to rollback.", type: "warn" });
      return dryRun ? { reverted: [], planned: [] } : { reverted: [] };
    }

    const count = resolveStepCount(options.steps, executed.length);
    const plan = executed
      .slice(-count)
      .reverse()
      .map((entry) => entry.name);

    if (dryRun) {
      log({ text: "Dry run — no changes will be made.", type: "info" });
      for (const file of plan) {
        log({ text: `${file} would be rolled back`, type: "info" });
      }
      return { reverted: [], planned: plan };
    }

    const reverted: string[] = [];

    for (const entry of executed.slice(-count).reverse()) {
      try {
        await revertOne(driver, listDir, entry.name);
      } catch (error) {
        log({ text: `${entry.name} rollback failed`, type: "error", error });
        throw error;
      }
      reverted.push(entry.name);
    }

    return { reverted };
  });
}
