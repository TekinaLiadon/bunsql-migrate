import { resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import { type RedoOptions, type RedoResult } from "./options.js";
import { migrateDown, parseSteps } from "./down.js";
import { migrateUp } from "./up.js";
import { migrateStatus } from "./status.js";
import { assertTargetOptions } from "./pending.js";

export async function migrateRedo(options: RedoOptions = {}): Promise<RedoResult> {
  const listDir = resolveListDir(options.listDir);
  const target = options.to;
  const steps = parseSteps(options.steps);

  await assertTargetOptions("redo", listDir, target, options.steps);

  const { applied } = await migrateStatus(options);
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
    }
    throw error;
  }
}
