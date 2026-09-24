import type { ExecutedMigration, MigrationDriver } from "../core/driver.js";

export async function ensureTrackingTable(driver: MigrationDriver): Promise<void> {
  if (driver.trackingTableCurrent !== undefined && (await driver.trackingTableCurrent())) {
    return;
  }
  await driver.install();
}

export async function listExecutedForPlan(driver: MigrationDriver): Promise<ExecutedMigration[]> {
  if ((await driver.trackingTableExists?.()) === false) {
    return [];
  }
  return driver.listExecuted();
}

export async function loadExecutedHistory(
  driver: MigrationDriver,
  dryRun: boolean,
): Promise<ExecutedMigration[]> {
  if (dryRun) {
    return listExecutedForPlan(driver);
  }
  await ensureTrackingTable(driver);
  return driver.listExecuted();
}
