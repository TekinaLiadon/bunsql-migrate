import { type SQL } from "bun";
import type { MigrationDriver } from "../core/driver.js";

export async function runMigrationStep(
  driver: MigrationDriver,
  step: (tx?: SQL) => Promise<void>,
): Promise<void> {
  if (step.length > 0) {
    await driver.transaction((tx) => step(tx));
    return;
  }
  await step();
}
