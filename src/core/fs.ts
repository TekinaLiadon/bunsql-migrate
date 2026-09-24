import { readdir } from "node:fs/promises";
import path from "node:path";
import { getMigrationListDir } from "./env.js";

export const DEFAULT_MIGRATIONS_DIR = "migrations";

export const MIGRATION_EXTENSIONS = ["js", "ts", "up.sql"] as const;

const MIGRATION_SUFFIXES = MIGRATION_EXTENSIONS.map((extension) => `.${extension}`);

const DECLARATION_SUFFIX = ".d.ts";

export function isMigrationFileName(name: string): boolean {
  if (name.endsWith(DECLARATION_SUFFIX)) return false;
  return MIGRATION_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export async function listFiles(dir: string, extensions: readonly string[]): Promise<string[]> {
  const suffixes = extensions.map((extension) => `.${extension}`);
  const matchedFiles: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      if (!isMigrationFileName(entry.name)) continue;
      matchedFiles.push(entry.name);
    }
  }
  return matchedFiles.sort().reverse();
}

export async function listMigrationFiles(listDir: string): Promise<string[]> {
  return listFiles(listDir, MIGRATION_EXTENSIONS);
}

export async function checksumFile(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(filePath).arrayBuffer());
  return hasher.digest("hex");
}

export async function checksumFiles(
  listDir: string,
  files: readonly string[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    files.map(async (file) => [file, await checksumFile(path.join(listDir, file))] as const),
  );
  return new Map(entries);
}

export function resolveListDir(override?: string): string {
  return path.resolve(
    override ?? getMigrationListDir() ?? path.join(process.cwd(), DEFAULT_MIGRATIONS_DIR),
  );
}
