import path from "node:path";
import { type SQL } from "bun";
import { MigrationFileMissingError } from "./options.js";

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

function hasParameterList(step: MigrationStep): boolean {
  const source = step.toString();
  const open = source.indexOf("(");
  if (open === -1) return false;
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) {
        return source.slice(open + 1, index).trim().length > 0;
      }
    }
  }
  return false;
}

function assertExplicitTransactionMode(
  file: string,
  direction: "up" | "down",
  step: MigrationStep,
): void {
  if (step.length > 0 || !hasParameterList(step)) return;
  throw new Error(
    `${file}: ${direction}() declares its parameter with a default value or as a rest parameter — ` +
      `function.length is 0, so the step would silently run outside the migration transaction; ` +
      `declare the parameter without a default (async (tx) => …) or add "export const noTransaction = true" to opt out explicitly`,
  );
}

async function sqlFilePlan(filePath: string): Promise<MigrationStepPlan> {
  const content = await Bun.file(filePath).text();
  return {
    step: sqlFileStep(filePath),
    noTransaction: hasNoTransactionDirective(content),
  };
}

export async function loadMigration(listDir: string, file: string): Promise<MigrationFunctions> {
  const migrationPath = path.join(listDir, file);
  if (!(await Bun.file(migrationPath).exists())) {
    throw new MigrationFileMissingError(file);
  }

  if (isSqlMigration(file)) {
    const downPath = path.join(listDir, sqlDownFile(file));
    return {
      up: await sqlFilePlan(migrationPath),
      down: (await Bun.file(downPath).exists()) ? await sqlFilePlan(downPath) : null,
    };
  }

  const mod = await import(migrationPath);
  const noTransaction = mod.noTransaction === true;
  const up = typeof mod.up === "function" ? { step: mod.up, noTransaction } : null;
  const down = typeof mod.down === "function" ? { step: mod.down, noTransaction } : null;
  if (!noTransaction) {
    if (up !== null) assertExplicitTransactionMode(file, "up", up.step);
    if (down !== null) assertExplicitTransactionMode(file, "down", down.step);
  }
  return { up, down };
}
