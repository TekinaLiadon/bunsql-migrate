import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InvalidConfigError, loadProjectConfig, type ProjectConfig } from "../src/index.js";
import { cliEnv, readRecords, readTables, runCli, writeTableMigration } from "./helpers.js";

interface Project {
  dir: string;
  listDir: string;
  dbPath: string;
  decoyDbPath: string;
  cleanup(): void;
}

function makeProject(prefix: string): Project {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const listDir = path.join(dir, "migrations");
  mkdirSync(listDir, { recursive: true });
  return {
    dir,
    listDir,
    dbPath: path.join(dir, "migrate.db"),
    decoyDbPath: path.join(dir, "decoy.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeConfig(project: Project, body: string, name = "bunsql-migrate.config.ts"): string {
  const configPath = path.join(project.dir, name);
  writeFileSync(configPath, body);
  return configPath;
}

describe("project config loader", () => {
  it("reports an explicit path that does not exist", async () => {
    const project = makeProject("bunsql-config-none-");
    try {
      const missing = path.join(project.dir, "bunsql-migrate.config.ts");

      await expect(loadProjectConfig(missing)).rejects.toBeInstanceOf(InvalidConfigError);
      await expect(loadProjectConfig(missing)).rejects.toThrow("config file not found");
    } finally {
      project.cleanup();
    }
  });

  it("reads the exported values from an explicit path", async () => {
    const project = makeProject("bunsql-config-read-");
    try {
      const configPath = writeConfig(
        project,
        `export default {
  databaseUrl: "postgres://user:pass@localhost:5432/app",
  listDir: "./db-migrations",
  tableName: "app_migrations",
  schema: "private",
  lang: "js",
  lockTimeout: 60,
  waitTimeout: 10,
};`,
      );

      const config = await loadProjectConfig(configPath);

      expect(config).toEqual({
        databaseUrl: "postgres://user:pass@localhost:5432/app",
        listDir: "./db-migrations",
        tableName: "app_migrations",
        schema: "private",
        lang: "js",
        lockTimeout: 60,
        waitTimeout: 10,
      } satisfies ProjectConfig);
    } finally {
      project.cleanup();
    }
  });

  it("accepts named exports instead of a default export", async () => {
    const project = makeProject("bunsql-config-named-");
    try {
      const configPath = writeConfig(
        project,
        `export const tableName = "named_migrations";
export const lang = "js";`,
      );

      const config = await loadProjectConfig(configPath);

      expect(config).toEqual({ tableName: "named_migrations", lang: "js" });
    } finally {
      project.cleanup();
    }
  });

  it("rejects an unknown key with the file name", async () => {
    const project = makeProject("bunsql-config-unknown-");
    try {
      const configPath = writeConfig(project, `export default { tableName: "t", engine: "pg" };`);

      await expect(loadProjectConfig(configPath)).rejects.toBeInstanceOf(InvalidConfigError);
      await expect(loadProjectConfig(configPath)).rejects.toThrow(
        `${path.basename(configPath)}: unknown config key "engine"`,
      );
    } finally {
      project.cleanup();
    }
  });

  it("rejects values of the wrong type", async () => {
    const project = makeProject("bunsql-config-types-");
    try {
      const configPath = writeConfig(
        project,
        `export default { tableName: 42, lang: "jsx", lockTimeout: -1 };`,
      );

      await expect(loadProjectConfig(configPath)).rejects.toThrow(
        `${path.basename(configPath)}: expected a string for "tableName"`,
      );
      await expect(loadProjectConfig(configPath)).rejects.toThrow(
        `expected "js" or "ts" for "lang"`,
      );
      await expect(loadProjectConfig(configPath)).rejects.toThrow(
        `expected a non-negative integer for "lockTimeout"`,
      );
    } finally {
      project.cleanup();
    }
  });

  it("rejects a config file that fails to load", async () => {
    const project = makeProject("bunsql-config-syntax-");
    try {
      const configPath = writeConfig(project, `export default { tableName: "t" oops };`);

      await expect(loadProjectConfig(configPath)).rejects.toThrow(
        `${path.basename(configPath)}: could not load the config file`,
      );
    } finally {
      project.cleanup();
    }
  });

  it("rejects a config without an object export", async () => {
    const project = makeProject("bunsql-config-object-");
    try {
      const configPath = writeConfig(project, `export default "migrations";`);

      await expect(loadProjectConfig(configPath)).rejects.toThrow(`must export a config object`);
    } finally {
      project.cleanup();
    }
  });
});

describe("CLI config file", () => {
  it("applies the config defaults for up, status and create", async () => {
    const project = makeProject("bunsql-config-defaults-");
    try {
      writeConfig(
        project,
        `export default {
  databaseUrl: "sqlite:${project.dbPath}",
  tableName: "app_migrations",
  lang: "js",
};`,
      );
      writeTableMigration(project.listDir, "1_a.js", "a_table");

      const up = await runCli(["up"], cliEnv(), project.dir);
      expect(up.exitCode).toBe(0);
      expect(readRecords(project.dbPath, "app_migrations").map((r) => r.migration)).toEqual([
        "1_a.js",
      ]);

      const status = await runCli(["status"], cliEnv(), project.dir);
      expect(status.exitCode).toBe(0);
      expect(status.output).toContain("1 applied, 0 pending");

      const create = await runCli(["create", "add_users"], cliEnv(), project.dir);
      expect(create.exitCode).toBe(0);
      expect(readdirSync(project.listDir).filter((f) => f.endsWith("_add_users.js"))).toHaveLength(
        1,
      );
    } finally {
      project.cleanup();
    }
  });

  it("lets a flag override the config", async () => {
    const project = makeProject("bunsql-config-flag-");
    try {
      writeConfig(project, `export default { databaseUrl: "sqlite:${project.dbPath}" };`);
      writeTableMigration(project.listDir, "1_a.js", "a_table");

      const up = await runCli(["up", "--table", "flag_migrations"], cliEnv(), project.dir);
      expect(up.exitCode).toBe(0);
      expect(readTables(project.dbPath)).toContain("flag_migrations");
      expect(readTables(project.dbPath)).not.toContain("migrations");
    } finally {
      project.cleanup();
    }
  });

  it("wins over the DATABASE_URL env var, which stays untouched", async () => {
    const project = makeProject("bunsql-config-url-");
    try {
      writeConfig(project, `export default { databaseUrl: "sqlite:${project.dbPath}" };`);
      writeTableMigration(project.listDir, "1_a.js", "a_table");

      const up = await runCli(
        ["up"],
        cliEnv({ databaseUrl: `sqlite:${project.decoyDbPath}` }),
        project.dir,
      );
      expect(up.exitCode).toBe(0);
      expect(readRecords(project.dbPath).map((r) => r.migration)).toEqual(["1_a.js"]);
      expect(readTables(project.decoyDbPath)).toHaveLength(0);
    } finally {
      project.cleanup();
    }
  });

  it("falls back to the env vars for the keys the config does not set", async () => {
    const project = makeProject("bunsql-config-env-");
    const envListDir = path.join(project.dir, "env-list");
    mkdirSync(envListDir, { recursive: true });
    try {
      writeConfig(project, `export default { tableName: "env_migrations" };`);
      writeTableMigration(envListDir, "1_a.js", "a_table");

      const up = await runCli(
        ["up"],
        cliEnv({
          databaseUrl: `sqlite:${project.dbPath}`,
          listDir: envListDir,
        }),
        project.dir,
      );
      expect(up.exitCode).toBe(0);
      expect(readRecords(project.dbPath, "env_migrations").map((r) => r.migration)).toEqual([
        "1_a.js",
      ]);
    } finally {
      project.cleanup();
    }
  });

  it("keeps every command working without a config file", async () => {
    const project = makeProject("bunsql-config-absent-");
    try {
      writeTableMigration(project.listDir, "1_a.js", "a_table");
      const env = cliEnv({
        databaseUrl: `sqlite:${project.dbPath}`,
        listDir: project.listDir,
      });

      const status = await runCli(["status", "--strict"], env, project.dir);
      expect(status.exitCode).toBe(2);
      expect(status.output).toContain("1 pending");

      const up = await runCli(["up"], env, project.dir);
      expect(up.exitCode).toBe(0);
      expect(readRecords(project.dbPath).map((r) => r.migration)).toEqual(["1_a.js"]);
    } finally {
      project.cleanup();
    }
  });

  it("loads a config file named by --config", async () => {
    const project = makeProject("bunsql-config-explicit-");
    try {
      writeConfig(
        project,
        `export default { databaseUrl: "sqlite:${project.dbPath}", tableName: "custom_migrations" };`,
        "custom.config.ts",
      );
      writeTableMigration(project.listDir, "1_a.js", "a_table");

      const up = await runCli(["up", "--config", "custom.config.ts"], cliEnv(), project.dir);
      expect(up.exitCode).toBe(0);
      expect(readRecords(project.dbPath, "custom_migrations").map((r) => r.migration)).toEqual([
        "1_a.js",
      ]);
    } finally {
      project.cleanup();
    }
  });

  it("fails before connecting when the config is broken", async () => {
    const project = makeProject("bunsql-config-broken-");
    try {
      writeTableMigration(project.listDir, "1_a.js", "a_table");
      const env = cliEnv({ databaseUrl: `sqlite:${project.dbPath}` });

      writeConfig(project, `export default { databaseUrl: "sqlite:${project.dbPath}" } oops;`);
      const syntax = await runCli(["up"], env, project.dir);
      expect(syntax.exitCode).toBe(5);
      expect(syntax.output).toContain("could not load the config file");
      expect(existsSync(project.dbPath)).toBe(false);

      writeConfig(project, `export default { tableName: "t", engine: "pg" };`);
      const unknown = await runCli(["up"], env, project.dir);
      expect(unknown.exitCode).toBe(5);
      expect(unknown.output).toContain(`unknown config key "engine"`);
      expect(existsSync(project.dbPath)).toBe(false);

      writeConfig(project, `export default { tableName: 42 };`);
      const typed = await runCli(["status"], env, project.dir);
      expect(typed.exitCode).toBe(5);
      expect(typed.output).toContain(`expected a string for "tableName"`);
      expect(existsSync(project.dbPath)).toBe(false);
    } finally {
      project.cleanup();
    }
  });

  it("reports a --config path that does not exist", async () => {
    const project = makeProject("bunsql-config-missing-");
    try {
      const status = await runCli(
        ["status", "--config", "nope.config.ts"],
        cliEnv({ databaseUrl: `sqlite:${project.dbPath}` }),
        project.dir,
      );
      expect(status.exitCode).toBe(5);
      expect(status.output).toContain("nope.config.ts");
      expect(status.output).toContain("not found");
    } finally {
      project.cleanup();
    }
  });

  it("rejects an invalid table name from the config before connecting", async () => {
    const project = makeProject("bunsql-config-identifier-");
    try {
      writeConfig(
        project,
        `export default { databaseUrl: "sqlite:${project.dbPath}", tableName: "not allowed!" };`,
      );
      writeTableMigration(project.listDir, "1_a.js", "a_table");

      const up = await runCli(["up"], cliEnv(), project.dir);
      expect(up.exitCode).toBe(5);
      expect(up.output).toContain("Invalid table name");
      expect(existsSync(project.dbPath)).toBe(false);
    } finally {
      project.cleanup();
    }
  });
});
