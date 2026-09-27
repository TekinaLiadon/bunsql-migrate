import { resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import { type RedoOptions, type RedoResult } from "./options.js";
import { migrateDown, parseSteps } from "./down.js";
import { migrateUp } from "./up.js";
import { runWithDriver } from "./run-with-driver.js";
import { listExecutedForPlan } from "./tracking-table.js";
import { assertTargetOptions } from "./pending.js";

async function warnPartialRevert(
  options: RedoOptions,
  appliedNames: readonly string[],
): Promise<void> {
  const current = await runWithDriver(options, (driver) => listExecutedForPlan(driver)).catch(
    () => undefined,
  );
  if (current === undefined) {
    return;
  }
  const recorded = new Set(current.map((entry) => entry.name));
  const revertedNames = appliedNames.filter((name) => !recorded.has(name));
  if (revertedNames.length === 0) {
    return;
  }
  log({
    text: "Redo: the down phase failed — the rollbacks above stay reverted; run up to re-apply them",
    type: "warn",
  });
}

export async function migrateRedo(options: RedoOptions = {}): Promise<RedoResult> {
  const listDir = resolveListDir(options.listDir);
  const target = options.to;
  const steps = parseSteps(options.steps);

  await assertTargetOptions("redo", listDir, target, options.steps);

  const applied = await runWithDriver(options, (driver) => listExecutedForPlan(driver));
  const lastApplied = applied.at(-1)?.name;
  if (lastApplied === undefined) {
    log({ text: "No migrations to redo.", type: "warn" });
    return { reverted: [], applied: [] };
  }

  const appliedNames = applied.map((entry) => entry.name);
  if (target !== undefined && !appliedNames.includes(target)) {
    log({ text: `${target} is not applied — nothing to redo.`, type: "warn" });
    return { reverted: [], applied: [] };
  }

  let reverted: string[] = [];
  try {
    ({ reverted } =
      target !== undefined ? await migrateDown(options) : await migrateDown({ ...options, steps }));
    const up = await migrateUp({ ...options, to: lastApplied });
    return { reverted, applied: up.applied };
  } catch (error) {
    if (reverted.length > 0) {
      log({
        text: "Redo: the up phase failed — the rollbacks above stay reverted; run up to re-apply them",
        type: "warn",
      });
    } else {
      await warnPartialRevert(options, appliedNames);
    }
    throw error;
  }
}
