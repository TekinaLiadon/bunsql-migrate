import { type SQL } from "bun";
import type { MigrationDriver } from "../core/driver.js";
import type { MigrationStepPlan } from "./load-migration.js";

export async function runMigrationStep(
  driver: MigrationDriver,
  plan: MigrationStepPlan,
): Promise<number> {
  const startedAt = performance.now();
  if (plan.noTransaction) {
    await runOutsideTransaction(driver, plan.step);
    return performance.now() - startedAt;
  }
  if (plan.step.length > 0) {
    await driver.transaction((tx) => plan.step(tx));
    return performance.now() - startedAt;
  }
  await plan.step();
  return performance.now() - startedAt;
}

function runOutsideTransaction(
  driver: MigrationDriver,
  step: (tx?: SQL) => Promise<void>,
): Promise<void> {
  const client = driver.client?.();
  if (client === undefined) {
    throw new Error(
      "this driver does not expose a non-transactional client — the noTransaction marker is unsupported here",
    );
  }
  return step(client);
}
