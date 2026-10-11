import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { errorCode, BunsqlMigrateError } from "./error.js";
import { getMigrationListDir } from "./env.js";

export const DEFAULT_MIGRATIONS_DIR = "migrations";

export const MIGRATION_EXTENSIONS = ["js", "ts", "up.sql"] as const;

const MIGRATION_SUFFIXES = MIGRATION_EXTENSIONS.map((extension) => `.${extension}`);

const DECLARATION_SUFFIX = ".d.ts";

export class MigrationsDirectoryNotFoundError extends BunsqlMigrateError {
  readonly directory: string;

  constructor(directory: string) {
    super("usage", `migrations directory not found: ${directory} — run init or pass --dir`);
    this.name = "MigrationsDirectoryNotFoundError";
    this.directory = directory;
  }
}

function toMissingDirectoryError(dir: string, error: unknown): Error {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new MigrationsDirectoryNotFoundError(dir);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function assertMigrationsDirectory(listDir: string): Promise<void> {
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(listDir)).isDirectory();
  } catch (error) {
    throw toMissingDirectoryError(listDir, error);
  }
  if (!isDirectory) {
    throw new MigrationsDirectoryNotFoundError(listDir);
  }
}

export function isMigrationFileName(name: string): boolean {
  if (name.endsWith(DECLARATION_SUFFIX)) return false;
  return MIGRATION_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

async function isFileTarget(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  const matchedFiles: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw toMissingDirectoryError(dir, error);
  }
  for (const entry of entries) {
    if (!isMigrationFileName(entry.name)) continue;
    if (entry.isFile()) {
      matchedFiles.push(entry.name);
      continue;
    }
    if (entry.isSymbolicLink() && (await isFileTarget(path.join(dir, entry.name)))) {
      matchedFiles.push(entry.name);
    }
  }
  return matchedFiles.sort().reverse();
}

export async function listMigrationFiles(listDir: string): Promise<string[]> {
  return listFiles(listDir);
}

export function requireChecksum(checksums: ReadonlyMap<string, string>, file: string): string {
  const checksum = checksums.get(file);
  if (checksum === undefined) {
    throw new Error(`checksum for ${file} was not computed`);
  }
  return checksum;
}

function normalizeFileContent(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function sha256(data: string | ArrayBuffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

export async function checksumFile(filePath: string): Promise<string> {
  return sha256(normalizeFileContent(await Bun.file(filePath).text()));
}

export async function matchesRawChecksum(filePath: string, checksum: string): Promise<boolean> {
  const bytes = await Bun.file(filePath).arrayBuffer();
  const content = normalizeFileContent(new TextDecoder().decode(bytes));
  const crlfContent = content.replaceAll("\n", "\r\n");
  const variants = [
    sha256(bytes),
    sha256(content),
    sha256(`\uFEFF${content}`),
    sha256(crlfContent),
    sha256(`\uFEFF${crlfContent}`),
  ];
  return variants.includes(checksum);
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
