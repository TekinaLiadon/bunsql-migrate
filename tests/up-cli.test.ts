import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

const CLI_ENTRY = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");

interface MigrationScenario {
  dbPath: string;
  listDir: string;
  env: Record<string, string>;
}

function makeScenario(): MigrationScenario {
  const dir = mkdtempSync(path.join(tmpdir(), "bunsql-migrate-"));
  const dbPath = path.join(dir, "migrate.db");
  const listDir = path.join(dir, "list");
  mkdirSync(listDir, { recursive: true });
  const env = {
    ...process.env,
    DATABASE_URL: `sqlite:${dbPath}`,
    MIGRATION_LIST_DIR: listDir,
  };
  return { dbPath, listDir, env };
}

function writeMigration(listDir: string, file: string, upBody: string): void {
  writeFileSync(
    path.join(listDir, file),
    `import { sql } from "bun";
const up = async () => {
  ${upBody}
};
const down = async () => {};
export { up, down };
`,
  );
}

async function runCli(
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

function readTables(dbPath: string): string[] {
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

function readRecorded(dbPath: string): string[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ migration: string }, []>("SELECT migration FROM migrations ORDER BY id ASC")
      .all()
      .map((row) => row.migration);
  } finally {
    db.close();
  }
}

function readChecksums(dbPath: string): Record<string, string | null> {
  const db = new Database(dbPath);
  try {
    const rows = db
      .query<{ migration: string; checksum: string | null }, []>(
        "SELECT migration, checksum FROM migrations ORDER BY id ASC",
      )
      .all();
    return Object.fromEntries(rows.map((row) => [row.migration, row.checksum]));
  } finally {
    db.close();
  }
}

describe("bunsql-migrate CLI", () => {
  it("prints usage and exits 0 for --help", async () => {
    const { env } = makeScenario();
    const help = await runCli(["--help"], env);
    expect(help.exitCode).toBe(0);
    expect(help.output).toContain("Usage: bunsql-native-migrate");
  });

  it("prints usage and exits 0 for -h", async () => {
    const { env } = makeScenario();
    const help = await runCli(["-h"], env);
    expect(help.exitCode).toBe(0);
    expect(help.output).toContain("Usage: bunsql-native-migrate");
  });

  it("exits with code 1 and prints usage on an unknown command", async () => {
    const { env } = makeScenario();
    const unknown = await runCli(["frobnicate"], env);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toContain("Usage: bunsql-native-migrate");
  });

  it("stops at the first failing migration and exits with code 1", async () => {
    const { dbPath, listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "3_first.js", "await sql`CREATE TABLE first_table (id INTEGER)`;");
      writeMigration(
        listDir,
        "2_failing.js",
        "await sql`CREATE TABLE partial_table (id INTEGER)`;\n  throw new Error('boom');",
      );
      writeMigration(listDir, "1_third.js", "await sql`CREATE TABLE third_table (id INTEGER)`;");

      expect((await runCli(["install"], env)).exitCode).toBe(0);

      const up = await runCli(["up"], env);
      expect(up.exitCode).toBe(1);
      expect(up.output).toContain("2_failing.js migration failed");

      const tables = readTables(dbPath);
      expect(tables).toContain("first_table");
      expect(tables).toContain("partial_table");
      expect(tables).not.toContain("third_table");
      expect(readRecorded(dbPath)).toEqual(["3_first.js"]);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("applies all migrations and exits with code 0", async () => {
    const { dbPath, listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "2_second.js", "await sql`CREATE TABLE second_table (id INTEGER)`;");
      writeMigration(listDir, "1_first.js", "await sql`CREATE TABLE first_table (id INTEGER)`;");

      expect((await runCli(["install"], env)).exitCode).toBe(0);
      expect((await runCli(["up"], env)).exitCode).toBe(0);

      const tables = readTables(dbPath);
      expect(tables).toContain("first_table");
      expect(tables).toContain("second_table");
      expect(readRecorded(dbPath)).toEqual(["2_second.js", "1_first.js"]);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("exits with code 0 when there are no pending migrations", async () => {
    const { dbPath, env } = makeScenario();
    try {
      expect((await runCli(["install"], env)).exitCode).toBe(0);

      const up = await runCli(["up"], env);
      expect(up.exitCode).toBe(0);
      expect(up.output).toContain("No pending migrations.");
      expect(readRecorded(dbPath)).toEqual([]);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("applies only new migrations on a repeated run", async () => {
    const { dbPath, listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "2_first.js", "await sql`CREATE TABLE first_table (id INTEGER)`;");
      expect((await runCli(["install"], env)).exitCode).toBe(0);
      expect((await runCli(["up"], env)).exitCode).toBe(0);

      writeMigration(listDir, "1_new.js", "await sql`CREATE TABLE new_table (id INTEGER)`;");
      expect((await runCli(["up"], env)).exitCode).toBe(0);

      expect(readRecorded(dbPath)).toEqual(["2_first.js", "1_new.js"]);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("records the checksum of an applied migration and creates the table itself", async () => {
    const { dbPath, listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "1_only.js", "await sql`CREATE TABLE only_table (id INTEGER)`;");

      expect((await runCli(["up"], env)).exitCode).toBe(0);
      expect(readTables(dbPath)).toContain("only_table");

      const checksums = readChecksums(dbPath);
      expect(checksums["1_only.js"]).toBeTruthy();
      expect(checksums["1_only.js"]).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("fails when an applied migration was modified after being applied", async () => {
    const { dbPath, listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "1_first.js", "await sql`CREATE TABLE first_table (id INTEGER)`;");
      expect((await runCli(["up"], env)).exitCode).toBe(0);

      writeFileSync(path.join(listDir, "1_first.js"), "// tampered content\n");
      const up = await runCli(["up"], env);

      expect(up.exitCode).toBe(1);
      expect(up.output).toContain("1_first.js was modified after it was applied");
      expect(readRecorded(dbPath)).toEqual(["1_first.js"]);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("does not fail on a repeated run with unchanged files", async () => {
    const { dbPath, listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "1_first.js", "await sql`CREATE TABLE first_table (id INTEGER)`;");
      expect((await runCli(["up"], env)).exitCode).toBe(0);
      expect((await runCli(["up"], env)).exitCode).toBe(0);
      expect((await runCli(["up"], env)).output).toContain("No pending migrations.");
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("backfills checksums of legacy records without a checksum", async () => {
    const { dbPath, listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "1_first.js", "await sql`CREATE TABLE first_table (id INTEGER)`;");
      expect((await runCli(["up"], env)).exitCode).toBe(0);

      const legacy = new Database(dbPath);
      try {
        legacy.query("UPDATE migrations SET checksum = NULL").run();
      } finally {
        legacy.close();
      }

      expect((await runCli(["up"], env)).exitCode).toBe(0);
      expect(readChecksums(dbPath)["1_first.js"]).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("rolls back the last migration with the down command", async () => {
    const { dbPath, listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "2_second.js", "await sql`CREATE TABLE second_table (id INTEGER)`;");
      writeMigration(listDir, "1_first.js", "await sql`CREATE TABLE first_table (id INTEGER)`;");
      expect((await runCli(["up"], env)).exitCode).toBe(0);

      const down = await runCli(["down"], env);
      expect(down.exitCode).toBe(0);
      expect(down.output).toContain("1_first.js");
      expect(readRecorded(dbPath)).toEqual(["2_second.js"]);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("create generates a stub migration in the list dir", async () => {
    const { listDir, env } = makeScenario();
    try {
      const created = await runCli(["create", "custom_name"], env);
      expect(created.exitCode).toBe(0);
      expect(created.output).toContain("Migration created:");

      const files = await Array.fromAsync(new Bun.Glob("*.js").scan({ cwd: listDir }));
      expect(files).toHaveLength(1);
      expect(files[0]).toContain("custom_name.js");
    } finally {
      rmSync(path.dirname(listDir), { recursive: true, force: true });
    }
  });
});
