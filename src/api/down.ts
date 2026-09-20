import { resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import { formatDuration } from "../core/duration.js";
import type { MigrationDriver } from "../core/driver.js";
import { type MigrateDownOptions, type MigrateDownResult } from "./options.js";
import { runWithDriver } from "./run-with-driver.js";
import { runMigrationStep } from "./run-step.js";
import { isSqlMigration, loadMigration } from "./load-migration.js";
import { assertTargetOptions } from "./pending.js";
import { ensureTrackingTable, listExecutedForPlan } from "./tracking-table.js";

export function parseSteps(steps: number | undefined): number;
export function parseSteps(steps: number | "all" | undefined): number | "all";
export function parseSteps(steps: number | "all" | undefined): number | "all" {
  if (steps === undefined) return 1;
  if (steps === "all") return "all";
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error(`Invalid steps: ${String(steps)} — expected a positive integer or "all"`);
  }
  return steps;
}

function resolveStepCount(steps: number | "all" | undefined, appliedCount: number): number {
  const parsed = parseSteps(steps);
  return parsed === "all" ? appliedCount : parsed;
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
  const target = options.to;

  await assertTargetOptions("down", listDir, target, options.steps);

  return runWithDriver(options, async (driver) => {
    if (!dryRun) {
      await ensureTrackingTable(driver);
    }

    const executed = dryRun ? await listExecutedForPlan(driver) : await driver.listExecuted();
    if (executed.length === 0) {
      log({ text: "No migrations to rollback.", type: "warn" });
      return dryRun ? { reverted: [], planned: [] } : { reverted: [] };
    }

    const appliedNames = executed.map((entry) => entry.name);
    let count = resolveStepCount(options.steps, executed.length);
    if (target !== undefined) {
      const boundary = appliedNames.indexOf(target);
      if (boundary === -1) {
        log({ text: `${target} is not applied — nothing to rollback.`, type: "warn" });
        return dryRun ? { reverted: [], planned: [] } : { reverted: [] };
      }
      count = executed.length - boundary;
    }
    const revertList = executed.slice(-count).reverse();
    const plan = revertList.map((entry) => entry.name);

    if (dryRun) {
      log({ text: "Dry run — no changes will be made.", type: "info" });
      for (const file of plan) {
        log({ text: `${file} would be rolled back`, type: "info" });
      }
      return { reverted: [], planned: plan };
    }

    const reverted: string[] = [];

    for (const entry of revertList) {
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
