import { type SQL } from "bun";
import type { MigrationDriver } from "../core/driver.js";

export async function runMigrationStep(
  driver: MigrationDriver,
  step: (tx?: SQL) => Promise<void>,
): Promise<number> {
  const startedAt = performance.now();
  if (step.length > 0) {
    await driver.transaction((tx) => step(tx));
    return performance.now() - startedAt;
  }
  await step();
  return performance.now() - startedAt;
}
