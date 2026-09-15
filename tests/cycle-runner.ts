import { sql } from "bun";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChecksumDriftError, installMigrations, migrateDown, migrateUp } from "../src/index.js";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set");
}

const prefix = `cycle_${Date.now()}_`;
const tableA = `${prefix}a`;
const tableB = `${prefix}b`;
const fileA = `9999999999999_${prefix}a.js`;
const fileB = `9999999999998_${prefix}b.js`;

function migrationFile(table: string): string {
  return `import { sql } from "bun";
const up = async () => {
  await sql\`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT)\`;
  await sql\`INSERT INTO ${table} (id, name) VALUES (1, 'row')\`;
};
const down = async () => {
  await sql\`DROP TABLE ${table}\`;
};
export { up, down };
`;
}

const dir = mkdtempSync(path.join(tmpdir(), "bunsql-cycle-"));
const listDir = path.join(dir, "list");
const options = { databaseUrl: url, listDir };

try {
  mkdirSync(listDir, { recursive: true });
  writeFileSync(path.join(listDir, fileA), migrationFile(tableA));
  writeFileSync(path.join(listDir, fileB), migrationFile(tableB));

  await installMigrations(options);
  await installMigrations(options);

  const up = await migrateUp(options);
  if (up.applied.length !== 2 || up.applied[0] !== fileA || up.applied[1] !== fileB) {
    throw new Error(`unexpected applied order: ${JSON.stringify(up.applied)}`);
  }

  const rowsA = (await sql.unsafe(`SELECT COUNT(*) AS n FROM ${tableA}`)) as Array<{
    n: number | string;
  }>;
  const rowsB = (await sql.unsafe(`SELECT COUNT(*) AS n FROM ${tableB}`)) as Array<{
    n: number | string;
  }>;
  if (Number(rowsA[0]?.n) !== 1 || Number(rowsB[0]?.n) !== 1) {
    throw new Error("migration SQL did not land in the database");
  }

  const again = await migrateUp(options);
  if (again.applied.length !== 0) {
    throw new Error(`second up applied: ${JSON.stringify(again.applied)}`);
  }

  writeFileSync(path.join(listDir, fileA), `${migrationFile(tableA)}\n// tampered\n`);
  try {
    await migrateUp(options);
    throw new Error("expected ChecksumDriftError after tampering");
  } catch (error) {
    if (!(error instanceof ChecksumDriftError)) {
      throw error;
    }
  } finally {
    writeFileSync(path.join(listDir, fileA), migrationFile(tableA));
  }

  const first = await migrateDown(options);
  if (first.reverted !== fileB) {
    throw new Error(`expected down to revert ${fileB}, got ${first.reverted}`);
  }

  const second = await migrateDown(options);
  if (second.reverted !== fileA) {
    throw new Error(`expected down to revert ${fileA}, got ${second.reverted}`);
  }

  process.stdout.write("CYCLE-OK\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
