import path from "node:path";
import { type SQL } from "bun";

export type MigrationStep = (tx?: SQL) => Promise<void>;

export interface MigrationStepPlan {
  step: MigrationStep;
  noTransaction: boolean;
}

export interface MigrationFunctions {
  up: MigrationStepPlan | null;
  down: MigrationStepPlan | null;
}

const SQL_UP_SUFFIX = ".up.sql";
const NO_TRANSACTION_DIRECTIVE = "-- bunsql-migrate:no-transaction";

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

function hasNoTransactionDirective(content: string): boolean {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("--")) return false;
    if (trimmed === NO_TRANSACTION_DIRECTIVE) return true;
  }
  return false;
}

async function sqlFilePlan(filePath: string): Promise<MigrationStepPlan> {
  const content = await Bun.file(filePath).text();
  return {
    step: sqlFileStep(filePath),
    noTransaction: hasNoTransactionDirective(content),
  };
}

export async function loadMigration(listDir: string, file: string): Promise<MigrationFunctions> {
  if (isSqlMigration(file)) {
    const upPath = path.join(listDir, file);
    const downPath = path.join(listDir, sqlDownFile(file));
    return {
      up: await sqlFilePlan(upPath),
      down: (await Bun.file(downPath).exists()) ? await sqlFilePlan(downPath) : null,
    };
  }

  const mod = await import(path.join(listDir, file));
  const noTransaction = mod.noTransaction === true;
  return {
    up: typeof mod.up === "function" ? { step: mod.up, noTransaction } : null,
    down: typeof mod.down === "function" ? { step: mod.down, noTransaction } : null,
  };
}
