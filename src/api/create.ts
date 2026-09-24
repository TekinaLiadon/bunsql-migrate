import path from "node:path";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { randomName } from "../core/random-name.js";
import { resolveListDir } from "../core/fs.js";
import { log } from "../core/console.js";
import { GitStageError, validateMigrationName } from "./options.js";

export type MigrationLang = "js" | "ts";

export interface CreateOptions {
  name?: string;
  git?: boolean;
  lang?: MigrationLang;
  listDir: string;
}

const JS_TEMPLATE = `import { sql } from "bun";
// Write your migration SQL here (tx runs inside a transaction)
const up = async (tx) => {};

// Write your rollback SQL here
const down = async (tx) => {};

export { up, down };
`;

const TS_TEMPLATE = `import { sql, type SQL } from "bun";
// Write your migration SQL here (tx runs inside a transaction)
const up = async (tx: SQL) => {};

// Write your rollback SQL here
const down = async (tx: SQL) => {};

export { up, down };
`;

function stubTemplate(lang: MigrationLang): string {
  return lang === "js" ? JS_TEMPLATE : TS_TEMPLATE;
}

async function stageInGit(filePath: string): Promise<void> {
  const add = Bun.spawn({
    cmd: ["git", "add", filePath],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(add.stderr).text();
  const exitCode = await add.exited;
  if (exitCode !== 0) {
    throw new GitStageError(filePath, exitCode, stderr.trim());
  }
}

function migrationFilename(name: string, date: Date, lang: MigrationLang): string {
  const pad = (value: number) => (value <= 9 ? `0${value}` : `${value}`);
  const MAX_TIME = 9999999999999;
  const invertedTime = (MAX_TIME - date.getTime()).toString().padStart(13, "0");
  const timestamp = [
    invertedTime,
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join("_");
  return `${timestamp}_${name}.${lang}`;
}

async function writeStubExclusively(filePath: string, template: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(template);
  } finally {
    await handle.close();
  }
  return true;
}

export async function createMigration(options: CreateOptions): Promise<string> {
  const name = options.name ?? randomName();
  validateMigrationName(name);
  const lang = options.lang ?? "ts";
  await mkdir(options.listDir, { recursive: true });
  let filename = migrationFilename(name, new Date(), lang);
  let filePath = path.join(options.listDir, filename);
  while (!(await writeStubExclusively(filePath, stubTemplate(lang)))) {
    await Bun.sleep(1);
    filename = migrationFilename(name, new Date(), lang);
    filePath = path.join(options.listDir, filename);
  }

  if (options.git) {
    await stageInGit(filePath);
  }

  return filename;
}

export async function createMigrationCommand(
  options: Omit<CreateOptions, "listDir"> & { listDir?: string },
): Promise<string> {
  const filename = await createMigration({ ...options, listDir: resolveListDir(options.listDir) });
  log({ text: `Migration created: ${filename}`, type: "success" });
  if (options.git) {
    log({ text: `Staged in git: ${filename}`, type: "success" });
  }
  return filename;
}
