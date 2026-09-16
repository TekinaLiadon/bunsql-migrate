import path from "node:path";
import { resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import type { MigrationDriver } from "../core/driver.js";
import type { MigrateDownOptions, MigrateDownResult } from "./options.js";
import { runWithDriver } from "./run-with-driver.js";
import { runMigrationStep } from "./run-step.js";

function resolveStepCount(steps: number | "all" | undefined, appliedCount: number): number {
  if (steps === undefined) return 1;
  if (steps === "all") return appliedCount;
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error(`Invalid steps: ${String(steps)} — expected a positive integer or "all"`);
  }
  return steps;
}

async function revertOne(driver: MigrationDriver, listDir: string, file: string): Promise<void> {
  const mod = await import(path.join(listDir, file));

  if (typeof mod.down !== "function") {
    log({ text: `${file} has no down() export, removing tracking record`, type: "warn" });
    await driver.remove(file);
    log({ text: `${file} tracking record removed`, type: "success" });
    return;
  }

  await runMigrationStep(driver, mod.down);
  await driver.remove(file);
  log({ text: `${file} rolled back`, type: "success" });
}

export async function migrateDown(options: MigrateDownOptions = {}): Promise<MigrateDownResult> {
  const listDir = resolveListDir(options.listDir);

  return runWithDriver(options, async (driver) => {
    const executed = await driver.listExecuted();
    if (executed.length === 0) {
      log({ text: "No migrations to rollback.", type: "warn" });
      return { reverted: [] };
    }

    const count = resolveStepCount(options.steps, executed.length);
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
