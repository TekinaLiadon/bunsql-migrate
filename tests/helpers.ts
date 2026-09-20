import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

export interface Scenario {
  options: { databaseUrl: string; listDir: string };
  dir: string;
  dbPath: string;
  listDir: string;
  cleanup(): void;
}

export function makeScenario(prefix: string, dbFile = "migrate.db"): Scenario {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const dbPath = path.join(dir, dbFile);
  const listDir = path.join(dir, "list");
  mkdirSync(listDir, { recursive: true });
  return {
    options: { databaseUrl: `sqlite:${dbPath}`, listDir },
    dir,
    dbPath,
    listDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const CLI_ENTRY = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");

export function envWithoutDatabaseUrl(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...extra };
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "DATABASE_URL" && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export function writeTableMigration(listDir: string, file: string, table: string): void {
  writeFileSync(
    path.join(listDir, file),
    `const up = async (tx) => {
  await tx\`CREATE TABLE ${table} (id INTEGER)\`;
};
const down = async (tx) => {
  await tx\`DROP TABLE ${table}\`;
};
export { up, down };
`,
  );
}

export async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

export function readTables(dbPath: string): string[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

export function readRecorded(dbPath: string, table = "migrations"): string[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ migration: string }, []>(`SELECT migration FROM ${table} ORDER BY id ASC`)
      .all()
      .map((row) => row.migration);
  } finally {
    db.close();
  }
}

export function readRecords(
  dbPath: string,
  table = "migrations",
): Array<{ migration: string; checksum: string | null }> {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ migration: string; checksum: string | null }, []>(
        `SELECT migration, checksum FROM ${table} ORDER BY id ASC`,
      )
      .all();
  } finally {
    db.close();
  }
}

export function readChecksums(dbPath: string, table = "migrations"): Record<string, string | null> {
  return Object.fromEntries(readRecords(dbPath, table).map((row) => [row.migration, row.checksum]));
}

export function readRowCount(dbPath: string, table: string): number {
  const db = new Database(dbPath);
  try {
    const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}
