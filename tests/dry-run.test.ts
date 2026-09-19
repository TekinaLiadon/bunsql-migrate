import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { migrateUp, migrateDown, ChecksumDriftError } from "../src/index.js";

interface DryRunScenario {
  options: { databaseUrl: string; listDir: string };
  dbPath: string;
  listDir: string;
  cleanup(): void;
}

function makeScenario(): DryRunScenario {
  const dir = mkdtempSync(path.join(tmpdir(), "bunsql-dryrun-"));
  const dbPath = path.join(dir, "migrate.db");
  const listDir = path.join(dir, "list");
  mkdirSync(listDir, { recursive: true });
  return {
    options: { databaseUrl: `sqlite:${dbPath}`, listDir },
    dbPath,
    listDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeMigration(listDir: string, file: string, table: string): void {
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

function readChecksums(dbPath: string): (string | null)[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ checksum: string | null }, []>("SELECT checksum FROM migrations ORDER BY id ASC")
      .all()
      .map((row) => row.checksum);
  } finally {
    db.close();
  }
}

describe("migrateUp dryRun", () => {
  it("plans every pending migration on a fresh database and creates nothing", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(scenario.listDir, "1_a.js", "a_table");
      writeMigration(scenario.listDir, "2_b.js", "b_table");
      writeMigration(scenario.listDir, "3_c.js", "c_table");

      const result = await migrateUp({ ...scenario.options, dryRun: true });

      expect(result.applied).toEqual([]);
      expect(result.planned).toEqual(["3_c.js", "2_b.js", "1_a.js"]);
      expect(readTables(scenario.dbPath)).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("plans only pending migrations and leaves records untouched", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(scenario.listDir, "1_a.js", "a_table");
      writeMigration(scenario.listDir, "2_b.js", "b_table");
      writeMigration(scenario.listDir, "3_c.js", "c_table");
      await migrateUp({ ...scenario.options, to: "2_b.js" });
      const before = readRecorded(scenario.dbPath);

      const result = await migrateUp({ ...scenario.options, dryRun: true });

      expect(result.applied).toEqual([]);
      expect(result.planned).toEqual(["1_a.js"]);
      expect(readRecorded(scenario.dbPath)).toEqual(before);
      expect(readTables(scenario.dbPath)).not.toContain("a_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("respects to in the plan", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(scenario.listDir, "1_a.js", "a_table");
      writeMigration(scenario.listDir, "2_b.js", "b_table");

      const result = await migrateUp({ ...scenario.options, dryRun: true, to: "2_b.js" });

      expect(result.planned).toEqual(["2_b.js"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("still throws ChecksumDriftError for a modified applied file", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(scenario.listDir, "1_drift.js", "drift_table");
      await migrateUp(scenario.options);

      writeFileSync(path.join(scenario.listDir, "1_drift.js"), "// tampered\n");

      await expect(migrateUp({ ...scenario.options, dryRun: true })).rejects.toBeInstanceOf(
        ChecksumDriftError,
      );
    } finally {
      scenario.cleanup();
    }
  });

  it("skips the legacy NULL-checksum backfill", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(scenario.listDir, "1_legacy.js", "legacy_table");
      await migrateUp(scenario.options);
      const db = new Database(scenario.dbPath);
      try {
        db.query("UPDATE migrations SET checksum = NULL").run();
      } finally {
        db.close();
      }

      const result = await migrateUp({ ...scenario.options, dryRun: true });

      expect(result.applied).toEqual([]);
      expect(result.planned).toEqual([]);
      expect(readChecksums(scenario.dbPath)).toEqual([null]);
    } finally {
      scenario.cleanup();
    }
  });
});

describe("migrateDown dryRun", () => {
  it("plans the revert list without rolling anything back", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(scenario.listDir, "1_a.js", "a_table");
      writeMigration(scenario.listDir, "2_b.js", "b_table");
      writeMigration(scenario.listDir, "3_c.js", "c_table");
      await migrateUp(scenario.options);
      const before = readRecorded(scenario.dbPath);

      const one = await migrateDown({ ...scenario.options, dryRun: true });
      const two = await migrateDown({ ...scenario.options, dryRun: true, steps: 2 });
      const all = await migrateDown({ ...scenario.options, dryRun: true, steps: "all" });

      expect(one.reverted).toEqual([]);
      expect(one.planned).toEqual(["1_a.js"]);
      expect(two.planned).toEqual(["1_a.js", "2_b.js"]);
      expect(all.planned).toEqual(["1_a.js", "2_b.js", "3_c.js"]);
      expect(readRecorded(scenario.dbPath)).toEqual(before);
      for (const table of ["a_table", "b_table", "c_table"]) {
        expect(readTables(scenario.dbPath)).toContain(table);
      }
    } finally {
      scenario.cleanup();
    }
  });

  it("plans nothing when the history is empty", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(scenario.listDir, "1_a.js", "a_table");
      await migrateUp(scenario.options);
      await migrateDown({ ...scenario.options, steps: "all" });

      const result = await migrateDown({ ...scenario.options, dryRun: true });

      expect(result.reverted).toEqual([]);
      expect(result.planned).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });
});

describe("CLI --dry-run", () => {
  it("prints the plan and leaves the database unchanged", async () => {
    const scenario = makeScenario();
    try {
      writeMigration(scenario.listDir, "1_cli.js", "cli_table");
      writeMigration(scenario.listDir, "2_cli.js", "cli_table_2");
      await migrateUp({ ...scenario.options, to: "2_cli.js" });
      const recordedBefore = readRecorded(scenario.dbPath);
      const tablesBefore = readTables(scenario.dbPath);

      const cli = path.resolve(import.meta.dir, "../src/cli/main.ts");
      const run = (args: string[]) => {
        const proc = Bun.spawn(["bun", cli, ...args, "--dir", scenario.listDir], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, DATABASE_URL: scenario.options.databaseUrl },
        });
        return Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ] as const);
      };

      const [upCode, upOut, upErr] = await run(["up", "--dry-run"]);
      expect(upCode).toBe(0);
      expect(`${upOut}${upErr}`).toContain("Dry run");
      expect(`${upOut}${upErr}`).toContain("1_cli.js would be applied");
      expect(`${upOut}${upErr}`).toContain("Would apply 1 migration(s)");

      const [downCode, downOut, downErr] = await run(["down", "--dry-run"]);
      expect(downCode).toBe(0);
      expect(`${downOut}${downErr}`).toContain("2_cli.js would be rolled back");
      expect(`${downOut}${downErr}`).toContain("Would revert 1 migration(s)");

      expect(readRecorded(scenario.dbPath)).toEqual(recordedBefore);
      expect(readTables(scenario.dbPath)).toEqual(tablesBefore);
    } finally {
      scenario.cleanup();
    }
  });
});
