export function getDatabaseUrl(override?: string): string {
  const url = override ?? process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is not set. Add it to .env or export it in your shell.");
  }
  return url;
}

export function getMigrationListDir(): string | undefined {
  return process.env["MIGRATION_LIST_DIR"];
}
