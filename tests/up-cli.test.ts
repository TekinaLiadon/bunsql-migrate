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

  it("reports nothing to rollback and exits 0 on a fresh database", async () => {
    const { dbPath, env } = makeScenario();
    try {
      const down = await runCli(["down"], env);
      expect(down.exitCode).toBe(0);
      expect(down.output).toContain("No migrations to rollback.");
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
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
      writeMigration(listDir, "2_second.ts", "await sql`CREATE TABLE second_table (id INTEGER)`;");
      writeMigration(listDir, "1_first.js", "await sql`CREATE TABLE first_table (id INTEGER)`;");

      expect((await runCli(["install"], env)).exitCode).toBe(0);
      const up = await runCli(["up"], env);
      expect(up.exitCode).toBe(0);
      expect(up.output).toContain("1_first.js migrated up (");
      expect(up.output).toContain("2_second.ts migrated up (");

      const tables = readTables(dbPath);
      expect(tables).toContain("first_table");
      expect(tables).toContain("second_table");
      expect(readRecorded(dbPath)).toEqual(["2_second.ts", "1_first.js"]);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("status lists applied and pending migrations and exits 0", async () => {
    const { listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "2_second.js", "await sql`CREATE TABLE second_table (id INTEGER)`;");
      writeMigration(listDir, "1_first.ts", "await sql`CREATE TABLE first_table (id INTEGER)`;");

      const before = await runCli(["status"], env);
      expect(before.exitCode).toBe(0);
      expect(before.output).toContain("2_second.js pending");
      expect(before.output).toContain("1_first.ts pending");
      expect(before.output).toContain("0 applied, 2 pending");

      expect((await runCli(["up"], env)).exitCode).toBe(0);

      const after = await runCli(["status"], env);
      expect(after.exitCode).toBe(0);
      expect(after.output).toContain("2_second.js applied");
      expect(after.output).toContain("1_first.ts applied");
      expect(after.output).toContain("2 applied, 0 pending");
    } finally {
      rmSync(path.dirname(listDir), { recursive: true, force: true });
    }
  });

  it("status --strict exits 1 while migrations are pending and 0 after up", async () => {
    const { listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "1_only.js", "await sql`CREATE TABLE only_table (id INTEGER)`;");

      const pending = await runCli(["status", "--strict"], env);
      expect(pending.exitCode).toBe(1);
      expect(pending.output).toContain("Strict mode: 1 pending migration(s).");

      expect((await runCli(["up"], env)).exitCode).toBe(0);

      const clean = await runCli(["status", "--strict"], env);
      expect(clean.exitCode).toBe(0);
      expect(clean.output).not.toContain("Strict mode:");
    } finally {
      rmSync(path.dirname(listDir), { recursive: true, force: true });
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
      expect(down.output).toContain("1_first.js rolled back (");
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

      const files = await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: listDir }));
      expect(files).toHaveLength(1);
      expect(files[0]).toContain("custom_name.ts");
    } finally {
      rmSync(path.dirname(listDir), { recursive: true, force: true });
    }
  });

  it("create --lang js generates a .js stub that applies", async () => {
    const { dbPath, listDir, env } = makeScenario();
    try {
      const created = await runCli(["create", "js_cli", "--lang", "js"], env);
      expect(created.exitCode).toBe(0);
      expect(created.output).toContain(".js");

      expect((await runCli(["up"], env)).exitCode).toBe(0);
      expect(readRecorded(dbPath)[0]).toContain("js_cli.js");
    } finally {
      rmSync(path.dirname(listDir), { recursive: true, force: true });
    }
  });

  it("create rejects an unknown or missing --lang value", async () => {
    const { listDir, env } = makeScenario();
    try {
      const unknown = await runCli(["create", "x", "--lang", "py"], env);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.output).toContain("Unknown --lang value: py");

      const missing = await runCli(["create", "x", "--lang"], env);
      expect(missing.exitCode).toBe(1);
      expect(missing.output).toContain("expected js or ts");
    } finally {
      rmSync(path.dirname(listDir), { recursive: true, force: true });
    }
  });

  it("down <n> rolls back N migrations", async () => {
    const { dbPath, listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "3_c.js", "await sql`CREATE TABLE c_table (id INTEGER)`;");
      writeMigration(listDir, "2_b.js", "await sql`CREATE TABLE b_table (id INTEGER)`;");
      writeMigration(listDir, "1_a.js", "await sql`CREATE TABLE a_table (id INTEGER)`;");
      expect((await runCli(["up"], env)).exitCode).toBe(0);

      const down = await runCli(["down", "2"], env);
      expect(down.exitCode).toBe(0);
      expect(down.output).toContain("Reverted 2 migration(s).");
      expect(readRecorded(dbPath)).toEqual(["3_c.js"]);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("down --all rolls back everything", async () => {
    const { dbPath, listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "2_b.js", "await sql`CREATE TABLE b_table (id INTEGER)`;");
      writeMigration(listDir, "1_a.js", "await sql`CREATE TABLE a_table (id INTEGER)`;");
      expect((await runCli(["up"], env)).exitCode).toBe(0);

      const down = await runCli(["down", "--all"], env);
      expect(down.exitCode).toBe(0);
      expect(down.output).toContain("Reverted 2 migration(s).");
      expect(readRecorded(dbPath)).toEqual([]);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("down rejects a bad step argument", async () => {
    const { listDir, env } = makeScenario();
    try {
      const notNumber = await runCli(["down", "abc"], env);
      expect(notNumber.exitCode).toBe(1);
      expect(notNumber.output).toContain("Invalid step count: abc");

      const zero = await runCli(["down", "0"], env);
      expect(zero.exitCode).toBe(1);
      expect(zero.output).toContain("Invalid step count: 0");

      const both = await runCli(["down", "2", "--all"], env);
      expect(both.exitCode).toBe(1);
      expect(both.output).toContain("not both");
    } finally {
      rmSync(path.dirname(listDir), { recursive: true, force: true });
    }
  });

  it("up --to applies pending migrations up to the named one", async () => {
    const { dbPath, listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "3_c.js", "await sql`CREATE TABLE c_table (id INTEGER)`;");
      writeMigration(listDir, "2_b.js", "await sql`CREATE TABLE b_table (id INTEGER)`;");
      writeMigration(listDir, "1_a.js", "await sql`CREATE TABLE a_table (id INTEGER)`;");

      const partial = await runCli(["up", "--to", "2_b.js"], env);
      expect(partial.exitCode).toBe(0);
      expect(readRecorded(dbPath)).toEqual(["3_c.js", "2_b.js"]);

      expect((await runCli(["up"], env)).exitCode).toBe(0);
      expect(readRecorded(dbPath)).toEqual(["3_c.js", "2_b.js", "1_a.js"]);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("up --to with an unknown name exits 1", async () => {
    const { listDir, env } = makeScenario();
    try {
      const result = await runCli(["up", "--to", "nope.js"], env);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("nope.js is not in the migrations directory");
    } finally {
      rmSync(path.dirname(listDir), { recursive: true, force: true });
    }
  });

  it("init scaffolds the migrations directory with the first stub", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bunsql-init-"));
    try {
      const listDir = path.join(dir, "migrations");
      const env = { ...process.env, MIGRATION_LIST_DIR: listDir };

      const init = await runCli(["init"], env);
      expect(init.exitCode).toBe(0);
      expect(init.output).toContain("Migration created:");
      expect(init.output).toContain("initial.ts");
      expect(init.output).toContain("DATABASE_URL");
      expect(init.output).toContain("bunx bunsql-native-migrate up");

      const files = await Array.fromAsync(new Bun.Glob("*.*").scan({ cwd: listDir }));
      expect(files).toHaveLength(1);
      expect(files[0]).toContain("initial.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("init is idempotent: no duplicate stub on an existing migrations directory", async () => {
    const { listDir, env } = makeScenario();
    try {
      writeMigration(listDir, "1_existing.js", "await sql`CREATE TABLE init_table (id INTEGER)`;");
      expect((await runCli(["up"], env)).exitCode).toBe(0);

      const init = await runCli(["init"], env);
      expect(init.exitCode).toBe(0);
      expect(init.output).toContain("already has 1 migration(s)");
      expect(init.output).not.toContain("Migration created:");

      const files = await Array.fromAsync(new Bun.Glob("*.*").scan({ cwd: listDir }));
      expect(files).toEqual(["1_existing.js"]);
    } finally {
      rmSync(path.dirname(listDir), { recursive: true, force: true });
    }
  });

  it("init honors --dir for a nested directory that does not exist yet", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bunsql-init-dir-"));
    try {
      const nested = path.join(dir, "db", "versions");
      const env = { ...process.env, MIGRATION_LIST_DIR: nested };
      const init = await runCli(["init", "--dir", nested], env);
      expect(init.exitCode).toBe(0);
      expect(init.output).toContain("Migration created:");

      const files = await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: nested }));
      expect(files).toHaveLength(1);
      expect(files[0]).toContain("initial.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
