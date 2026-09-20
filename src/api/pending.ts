import { log } from "../core/console.js";
import { MigrationNotFoundError } from "./options.js";

export interface PendingToTargetResult {
  pending: string[];
  targetApplied: boolean;
}

interface ResolvePendingOptions {
  allFiles: string[];
  executedNames: string[];
  target: string | undefined;
}

export function resolvePendingToTarget({
  allFiles,
  executedNames,
  target,
}: ResolvePendingOptions): PendingToTargetResult {
  const executed = new Set(executedNames);

  if (target !== undefined && !allFiles.includes(target)) {
    throw new MigrationNotFoundError(target);
  }

  let pending = allFiles.filter((file) => !executed.has(file));
  let targetApplied = false;
  if (target !== undefined) {
    if (executed.has(target)) {
      log({ text: `${target} is already applied.`, type: "info" });
      targetApplied = true;
    } else {
      pending = pending.slice(0, pending.indexOf(target) + 1);
    }
  }
  return { pending, targetApplied };
}
