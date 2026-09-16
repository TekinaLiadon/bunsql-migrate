import { readdir } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MIGRATIONS_DIR = "migrations";

export const MIGRATION_EXTENSIONS = ["js", "ts"] as const;

export async function listFiles(dir: string, extensions: readonly string[]): Promise<string[]> {
  const matchedFiles: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(`.${ext}`))) {
      matchedFiles.push(entry.name);
    }
  }
  return matchedFiles.sort().reverse();
}

export async function checksumFile(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(filePath).arrayBuffer());
  return hasher.digest("hex");
}

export function resolveListDir(override?: string): string {
  return path.resolve(
    override ??
      process.env["MIGRATION_LIST_DIR"] ??
      path.join(process.cwd(), DEFAULT_MIGRATIONS_DIR),
  );
}
