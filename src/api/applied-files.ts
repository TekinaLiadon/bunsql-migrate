import type { ExecutedMigration } from "../core/driver.js";
import { log } from "../core/console.js";

export function warnAppliedButMissingFiles(
  listDir: string,
  executed: readonly ExecutedMigration[],
  allFiles: readonly string[],
): void {
  const files = new Set(allFiles);
  for (const entry of executed) {
    if (files.has(entry.name)) continue;
    log({
      text: `${entry.name} is applied in the database but missing from ${listDir} — down/redo will fail until the file is restored or its record removed`,
      type: "warn",
    });
  }
}
