import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  migrateUp,
  migrateDown,
  migrateStatus,
  installMigrations,
  createDriver,
  InvalidIdentifierError,
} from "../src/index.js";
import { makeScenario, readRecorded, readTables } from "./helpers.js";

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

describe("custom tracking table", () => {
  it("runs the full cycle against a custom tableName without creating the default table", async () => {
    const scenario = makeScenario("bunsql-table-");
    try {
      writeMigration(scenario.listDir, "1_custom.js", "custom_data_table");
      const options = { ...scenario.options, tableName: "app_migrations" };

      await installMigrations(options);
      await installMigrations(options);
      expect(readTables(scenario.dbPath)).toContain("app_migrations");
      expect(readTables(scenario.dbPath)).not.toContain("migrations");

      const result = await migrateUp(options);
      expect(result.applied).toEqual(["1_custom.js"]);
      expect(readRecorded(scenario.dbPath, "app_migrations")).toEqual(["1_custom.js"]);

      const status = await migrateStatus(options);
      expect(status.applied).toHaveLength(1);
      expect(status.pending).toEqual([]);

      const down = await migrateDown(options);
      expect(down.reverted).toEqual(["1_custom.js"]);
      expect(readRecorded(scenario.dbPath, "app_migrations")).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("keeps two custom tables in one database as separate histories", async () => {
    const scenario = makeScenario("bunsql-table-");
    try {
      const alphaDir = path.join(scenario.dir, "alpha");
      const betaDir = path.join(scenario.dir, "beta");
      mkdirSync(alphaDir);
      mkdirSync(betaDir);
      writeMigration(alphaDir, "1_alpha.js", "alpha_data");
      writeMigration(betaDir, "1_beta.js", "beta_data");
      const alpha = {
        databaseUrl: `sqlite:${scenario.dbPath}`,
        listDir: alphaDir,
        tableName: "alpha_migrations",
      };
      const beta = {
        databaseUrl: `sqlite:${scenario.dbPath}`,
        listDir: betaDir,
        tableName: "beta_migrations",
      };

      const first = await migrateUp(alpha);
      const second = await migrateUp(beta);

      expect(first.applied).toEqual(["1_alpha.js"]);
      expect(second.applied).toEqual(["1_beta.js"]);
      expect(readRecorded(scenario.dbPath, "alpha_migrations")).toEqual(["1_alpha.js"]);
      expect(readRecorded(scenario.dbPath, "beta_migrations")).toEqual(["1_beta.js"]);

      const reverted = await migrateDown(alpha);
      expect(reverted.reverted).toEqual(["1_alpha.js"]);
      expect(readRecorded(scenario.dbPath, "alpha_migrations")).toEqual([]);
      expect(readRecorded(scenario.dbPath, "beta_migrations")).toEqual(["1_beta.js"]);
      expect(readTables(scenario.dbPath)).not.toContain("alpha_data");
      expect(readTables(scenario.dbPath)).toContain("beta_data");
    } finally {
      scenario.cleanup();
    }
  });

  it("quotes a table name that is a SQL keyword", async () => {
    const scenario = makeScenario("bunsql-table-");
    try {
      writeMigration(scenario.listDir, "1_order.js", "ordered_table");

      const result = await migrateUp({
        databaseUrl: `sqlite:${scenario.dbPath}`,
        listDir: scenario.listDir,
        tableName: "order",
      });

      expect(result.applied).toEqual(["1_order.js"]);
      expect(readRecorded(scenario.dbPath, '"order"')).toEqual(["1_order.js"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("backfills a legacy record inside a custom table on up", async () => {
    const scenario = makeScenario("bunsql-table-");
    try {
      writeMigration(scenario.listDir, "1_legacy.js", "legacy_table");
      await migrateUp({
        databaseUrl: `sqlite:${scenario.dbPath}`,
        listDir: scenario.listDir,
        tableName: "legacy_migrations",
      });

      const db = new Database(scenario.dbPath);
      try {
        db.query("UPDATE legacy_migrations SET checksum = NULL").run();
      } finally {
        db.close();
      }

      const result = await migrateUp({
        databaseUrl: `sqlite:${scenario.dbPath}`,
        listDir: scenario.listDir,
        tableName: "legacy_migrations",
      });

      expect(result.applied).toEqual([]);
      const db2 = new Database(scenario.dbPath);
      try {
        const row = db2
          .query<{ checksum: string | null }, []>(
            "SELECT checksum FROM legacy_migrations WHERE migration = '1_legacy.js'",
          )
          .get();
        expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        db2.close();
      }
    } finally {
      scenario.cleanup();
    }
  });
});

describe("identifier validation", () => {
  it("rejects invalid table names with a domain error before touching the database", async () => {
    const scenario = makeScenario("bunsql-table-");
    try {
      const invalidNames = [
        "bad name",
        "drop;--",
        'quoted"name',
        "`injected`",
        "1starts_with_digit",
        "",
        "semi;colon",
      ];
      for (const tableName of invalidNames) {
        await expect(
          installMigrations({ databaseUrl: `sqlite:${scenario.dbPath}`, tableName }),
        ).rejects.toBeInstanceOf(InvalidIdentifierError);
      }
      expect(existsSync(scenario.dbPath)).toBe(false);
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects an invalid schema name before touching the database", async () => {
    const scenario = makeScenario("bunsql-table-");
    try {
      await expect(
        createDriver("postgres://user:pass@localhost:5432/db", { schema: "not allowed" }),
      ).rejects.toBeInstanceOf(InvalidIdentifierError);
      expect(existsSync(scenario.dbPath)).toBe(false);
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects the schema option on non-postgres URLs", async () => {
    const scenario = makeScenario("bunsql-table-");
    try {
      await expect(
        createDriver(`sqlite:${scenario.dbPath}`, { schema: "private" }),
      ).rejects.toThrow(/schema.*postgres|postgres.*schema/i);
      await expect(
        createDriver("mysql://user:pass@localhost:3306/db", { schema: "private" }),
      ).rejects.toThrow(/schema.*postgres|postgres.*schema/i);
      expect(existsSync(scenario.dbPath)).toBe(false);
    } finally {
      scenario.cleanup();
    }
  });
});
