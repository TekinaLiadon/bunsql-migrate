import { listFiles, MIGRATION_EXTENSIONS, resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import { createMigration, type MigrationLang } from "./create.js";

export interface InitOptions {
  listDir?: string;
  lang?: MigrationLang;
}

export interface InitResult {
  created: boolean;
  filename: string | null;
}

async function existingMigrations(listDir: string): Promise<string[]> {
  try {
    return await listFiles(listDir, MIGRATION_EXTENSIONS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function printNextSteps(): void {
  log({ text: "Next steps:", type: "info" });
  log({
    text: "1. Point DATABASE_URL at your database (postgres://, mariadb://, mysql:// or sqlite:)",
    type: "info",
  });
  log({ text: "2. Fill in the up() and down() bodies of the created migration", type: "info" });
  log({ text: "3. Run bunx bunsql-native-migrate up", type: "info" });
}

export async function initMigrations(options: InitOptions = {}): Promise<InitResult> {
  const listDir = resolveListDir(options.listDir);
  const existing = await existingMigrations(listDir);

  if (existing.length > 0) {
    log({
      text: `Migrations directory already has ${existing.length} migration(s): ${listDir}`,
      type: "info",
    });
    printNextSteps();
    return { created: false, filename: null };
  }

  const filename = await createMigration({
    name: "initial",
    ...(options.lang !== undefined ? { lang: options.lang } : {}),
    listDir,
  });
  log({ text: `Migration created: ${filename}`, type: "success" });
  printNextSteps();
  return { created: true, filename };
}
