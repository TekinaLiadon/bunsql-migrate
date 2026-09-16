import { sql } from "bun";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ChecksumDriftError,
  installMigrations,
  migrateDown,
  migrateStatus,
  migrateUp,
} from "../src/index.js";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set");
}

const prefix = `cycle_${Date.now()}_`;
const tableA = `${prefix}a`;
const tableB = `${prefix}b`;
const tableC = `${prefix}c`;
const fileA = `9999999999999_${prefix}a.js`;
const fileB = `9999999999998_${prefix}b.js`;
const fileC = `9999999999997_${prefix}c.js`;

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

function transactionalMigrationFile(table: string): string {
  return `const up = async (tx) => {
  await tx\`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT)\`;
  await tx\`INSERT INTO ${table} (id, name) VALUES (1, 'row')\`;
};
const down = async (tx) => {
  await tx\`DROP TABLE ${table}\`;
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
  writeFileSync(path.join(listDir, fileC), transactionalMigrationFile(tableC));

  await installMigrations(options);
  await installMigrations(options);

  const partial = await migrateUp({ ...options, to: fileB });
  if (
    partial.applied.length !== 2 ||
    partial.applied[0] !== fileA ||
    partial.applied[1] !== fileB
  ) {
    throw new Error(`unexpected partial applied order: ${JSON.stringify(partial.applied)}`);
  }

  const rest = await migrateUp(options);
  if (rest.applied.length !== 1 || rest.applied[0] !== fileC) {
    throw new Error(`unexpected remaining applied: ${JSON.stringify(rest.applied)}`);
  }

  const rowsA = (await sql.unsafe(`SELECT COUNT(*) AS n FROM ${tableA}`)) as Array<{
    n: number | string;
  }>;
  const rowsB = (await sql.unsafe(`SELECT COUNT(*) AS n FROM ${tableB}`)) as Array<{
    n: number | string;
  }>;
  const rowsC = (await sql.unsafe(`SELECT COUNT(*) AS n FROM ${tableC}`)) as Array<{
    n: number | string;
  }>;
  if (Number(rowsA[0]?.n) !== 1 || Number(rowsB[0]?.n) !== 1 || Number(rowsC[0]?.n) !== 1) {
    throw new Error("migration SQL did not land in the database");
  }

  const again = await migrateUp(options);
  if (again.applied.length !== 0) {
    throw new Error(`second up applied: ${JSON.stringify(again.applied)}`);
  }

  const statusAfterUp = await migrateStatus(options);
  if (statusAfterUp.applied.length !== 3 || statusAfterUp.pending.length !== 0) {
    throw new Error(`unexpected status after up: ${JSON.stringify(statusAfterUp)}`);
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

  const first = await migrateDown({ ...options, steps: 2 });
  if (first.reverted.length !== 2 || first.reverted[0] !== fileC || first.reverted[1] !== fileB) {
    throw new Error(
      `expected down(steps: 2) to revert [${fileC}, ${fileB}], got ${JSON.stringify(first.reverted)}`,
    );
  }

  const second = await migrateDown(options);
  if (second.reverted.length !== 1 || second.reverted[0] !== fileA) {
    throw new Error(`expected down to revert [${fileA}], got ${JSON.stringify(second.reverted)}`);
  }

  const statusAfterDown = await migrateStatus(options);
  if (statusAfterDown.applied.length !== 0 || statusAfterDown.pending.length !== 3) {
    throw new Error(`unexpected status after down: ${JSON.stringify(statusAfterDown)}`);
  }

  process.stdout.write("CYCLE-OK\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
