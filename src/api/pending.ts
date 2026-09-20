import { listFiles, MIGRATION_EXTENSIONS } from "../core/fs.js";
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

export function assertTargetInFiles(allFiles: readonly string[], target: string): void {
  if (!allFiles.includes(target)) {
    throw new MigrationNotFoundError(target);
  }
}

export async function assertTargetOptions(
  command: string,
  listDir: string,
  target: string | undefined,
  steps: unknown,
): Promise<void> {
  if (target !== undefined && steps !== undefined) {
    throw new Error(`Invalid ${command} options: "to" and "steps" cannot be combined`);
  }
  if (target !== undefined) {
    assertTargetInFiles(await listFiles(listDir, MIGRATION_EXTENSIONS), target);
  }
}

export function resolvePendingToTarget({
  allFiles,
  executedNames,
  target,
}: ResolvePendingOptions): PendingToTargetResult {
  const executed = new Set(executedNames);

  if (target !== undefined) {
    assertTargetInFiles(allFiles, target);
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
