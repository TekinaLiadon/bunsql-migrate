import path from "node:path";
import { type SQL } from "bun";

export type MigrationStep = (tx?: SQL) => Promise<void>;

export interface MigrationFunctions {
  up: MigrationStep | null;
  down: MigrationStep | null;
}

const SQL_UP_SUFFIX = ".up.sql";

export function isSqlMigration(file: string): boolean {
  return file.endsWith(SQL_UP_SUFFIX);
}

function sqlDownFile(file: string): string {
  return `${file.slice(0, -SQL_UP_SUFFIX.length)}.down.sql`;
}

function sqlFileStep(filePath: string): MigrationStep {
  return async (tx) => {
    if (tx === undefined) {
      throw new Error(`${filePath} can only run inside a migration transaction`);
    }
    await tx.file(filePath);
  };
}

export async function loadMigration(listDir: string, file: string): Promise<MigrationFunctions> {
  if (isSqlMigration(file)) {
    const upPath = path.join(listDir, file);
    const downPath = path.join(listDir, sqlDownFile(file));
    return {
      up: sqlFileStep(upPath),
      down: (await Bun.file(downPath).exists()) ? sqlFileStep(downPath) : null,
    };
  }

  const mod = await import(path.join(listDir, file));
  return {
    up: typeof mod.up === "function" ? mod.up : null,
    down: typeof mod.down === "function" ? mod.down : null,
  };
}
