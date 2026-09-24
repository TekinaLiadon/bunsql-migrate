import { describe, it, expect, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMigration, createMigrationCommand } from "../src/api/create.js";
import { GitStageError, InvalidMigrationNameError } from "../src/api/options.js";
import { envWithoutDatabaseUrl, runCli } from "./helpers.js";

function makeListDir(prefix: string): { root: string; list: string } {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const list = path.join(root, "list");
  mkdirSync(list, { recursive: true });
  return { root, list };
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

describe("createMigration()", () => {
  it("creates a migration with the given name", async () => {
    const { root, list } = makeListDir("bunsql-create-name-");
    try {
      const filename = await createMigration({ name: "my_migration", listDir: list });
      expect(filename).toContain("my_migration.ts");

      expect(readdirSync(list)).toEqual([filename]);
    } finally {
      cleanup(root);
    }
  });

  it("creates a migration with a random name when none is given", async () => {
    const { root, list } = makeListDir("bunsql-create-random-");
    try {
      const filename = await createMigration({ listDir: list });
      expect(filename).toMatch(/\.ts$/);

      expect(readdirSync(list)).toEqual([filename]);
    } finally {
      cleanup(root);
    }
  });

  it("names the file with an inverted 13-digit timestamp and YYYY_MM_DD date", async () => {
    const { root, list } = makeListDir("bunsql-create-timestamp-");
    try {
      const filename = await createMigration({ name: "timestamp_test", listDir: list });
      expect(filename).toMatch(/^\d{13}_\d{4}_\d{2}_\d{2}_timestamp_test\.ts$/);
    } finally {
      cleanup(root);
    }
  });

  it('creates a .js migration on request (lang: "js")', async () => {
    const { root, list } = makeListDir("bunsql-create-js-");
    try {
      const filename = await createMigration({ name: "js_stab", listDir: list, lang: "js" });
      expect(filename).toMatch(/^\d{13}_\d{4}_\d{2}_\d{2}_js_stab\.js$/);
      const content = await Bun.file(path.join(list, filename)).text();
      expect(content).toContain("async (tx)");
      expect(content).not.toContain(": SQL");
    } finally {
      cleanup(root);
    }
  });

  it('creates a .ts migration when lang: "ts" is explicit', async () => {
    const { root, list } = makeListDir("bunsql-create-ts-");
    try {
      const filename = await createMigration({ name: "ts_explicit", listDir: list, lang: "ts" });
      expect(filename).toMatch(/^\d{13}_\d{4}_\d{2}_\d{2}_ts_explicit\.ts$/);
    } finally {
      cleanup(root);
    }
  });

  it("never collapses concurrent creations with the same name", async () => {
    const collisionDir = mkdtempSync(path.join(tmpdir(), "bunsql-collision-"));
    try {
      const filenames = await Promise.all(
        Array.from({ length: 8 }, () =>
          createMigration({ name: "collision_check", listDir: collisionDir }),
        ),
      );
      expect(new Set(filenames).size).toBe(8);

      const files = readdirSync(collisionDir).filter((file) => file.endsWith("collision_check.ts"));
      expect(files.length).toBe(8);
    } finally {
      rmSync(collisionDir, { recursive: true, force: true });
    }
  });

  it("creates a non-empty file (stub template)", async () => {
    const { root, list } = makeListDir("bunsql-create-stub-");
    try {
      const filename = await createMigration({ name: "stub_check", listDir: list });
      const content = await Bun.file(path.join(list, filename)).text();
      expect(content).toContain("up");
      expect(content).toContain("down");
      expect(content).toContain("async (tx: SQL)");
      expect(content).not.toContain("sql``");
    } finally {
      cleanup(root);
    }
  });
});

describe("git staging", () => {
  it("stages the created migration when git: true", async () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "bunsql-git-"));
    const originalCwd = process.cwd();
    try {
      mkdirSync(path.join(repoDir, "list"), { recursive: true });
      Bun.spawnSync(["git", "init", "-q"], { cwd: repoDir });

      process.chdir(repoDir);
      const filename = await createMigration({
        name: "git_staged",
        listDir: path.join(repoDir, "list"),
        git: true,
      });

      const status = Bun.spawnSync(["git", "status", "--porcelain"]).stdout.toString();
      expect(status).toContain(filename);
    } finally {
      process.chdir(originalCwd);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("throws GitStageError and keeps the file when git add fails", async () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "bunsql-git-fail-"));
    const originalCwd = process.cwd();
    try {
      mkdirSync(path.join(repoDir, "list"), { recursive: true });
      Bun.spawnSync(["git", "init", "-q"], { cwd: repoDir });
      await Bun.write(path.join(repoDir, ".gitignore"), "list/\n");

      process.chdir(repoDir);
      const error = await createMigration({
        name: "git_stage_fail",
        listDir: path.join(repoDir, "list"),
        git: true,
      }).catch((err) => err);

      expect(error).toBeInstanceOf(GitStageError);
      expect(error.file).toContain("git_stage_fail.ts");
      expect(error.message).toContain("git add failed");
      expect(error.message).toContain("ignored");

      const files = readdirSync(path.join(repoDir, "list"));
      expect(files.some((file) => file.endsWith("git_stage_fail.ts"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("propagates GitStageError from createMigrationCommand", async () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "bunsql-git-cmd-fail-"));
    const originalCwd = process.cwd();
    const logSpy = spyOn(console, "log");
    try {
      mkdirSync(path.join(repoDir, "list"), { recursive: true });
      Bun.spawnSync(["git", "init", "-q"], { cwd: repoDir });
      await Bun.write(path.join(repoDir, ".gitignore"), "list/\n");

      process.chdir(repoDir);
      const error = await createMigrationCommand({
        name: "cmd_git_fail",
        listDir: path.join(repoDir, "list"),
        git: true,
      }).catch((err) => err);

      expect(error).toBeInstanceOf(GitStageError);
      const messages = logSpy.mock.calls.map((call) => String(call[1]));
      expect(messages.some((text) => text.includes("Staged in git"))).toBe(false);
    } finally {
      logSpy.mockRestore();
      process.chdir(originalCwd);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("migration name validation", () => {
  const invalidNames = [
    "../../escaped",
    "..",
    "foo/bar",
    "foo\\bar",
    "foo bar",
    "foo\nbar",
    "foo.bar",
    "",
    "a".repeat(129),
  ];

  for (const name of invalidNames) {
    it(`rejects ${JSON.stringify(name)} before touching the filesystem`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "bunsql-name-"));
      const dir = path.join(root, "list");
      try {
        await expect(createMigration({ name, listDir: dir })).rejects.toBeInstanceOf(
          InvalidMigrationNameError,
        );
        expect(existsSync(dir)).toBe(false);
        expect(readdirSync(root)).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("never escapes the migrations directory with a traversal name", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bunsql-traversal-"));
    const dir = path.join(root, "list");
    try {
      await expect(
        createMigration({ name: "../../../../../../tmp/bunsql-escaped", listDir: dir }),
      ).rejects.toBeInstanceOf(InvalidMigrationNameError);
      expect(existsSync("/tmp/bunsql-escaped.ts")).toBe(false);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages nothing when the name is rejected with --git", async () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "bunsql-git-name-"));
    const originalCwd = process.cwd();
    try {
      mkdirSync(path.join(repoDir, "list"), { recursive: true });
      Bun.spawnSync(["git", "init", "-q"], { cwd: repoDir });

      process.chdir(repoDir);
      await expect(
        createMigration({ name: "../../pwned", listDir: path.join(repoDir, "list"), git: true }),
      ).rejects.toBeInstanceOf(InvalidMigrationNameError);

      const status = Bun.spawnSync(["git", "status", "--porcelain"]).stdout.toString();
      expect(status.trim()).toBe("");
    } finally {
      process.chdir(originalCwd);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("createMigrationCommand()", () => {
  it("creates the migration in the given list dir", async () => {
    const { root, list } = makeListDir("bunsql-cmd-explicit-");
    try {
      const filename = await createMigrationCommand({ name: "cmd_explicit", listDir: list });
      expect(filename).toContain("cmd_explicit.ts");
      expect(readdirSync(list)).toContain(filename);
    } finally {
      cleanup(root);
    }
  });

  it("falls back to MIGRATION_LIST_DIR when no listDir is given", async () => {
    const { root, list } = makeListDir("bunsql-cmd-env-");
    const original = process.env["MIGRATION_LIST_DIR"];
    process.env["MIGRATION_LIST_DIR"] = list;
    try {
      const filename = await createMigrationCommand({ name: "cmd_env_dir" });
      expect(filename).toContain("cmd_env_dir.ts");
      expect(readdirSync(list)).toContain(filename);
    } finally {
      if (original === undefined) {
        delete process.env["MIGRATION_LIST_DIR"];
      } else {
        process.env["MIGRATION_LIST_DIR"] = original;
      }
      cleanup(root);
    }
  });

  it("logs creation and git staging", async () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "bunsql-git-cmd-"));
    const originalCwd = process.cwd();
    const logSpy = spyOn(console, "log");
    try {
      mkdirSync(path.join(repoDir, "list"), { recursive: true });
      Bun.spawnSync(["git", "init", "-q"], { cwd: repoDir });

      process.chdir(repoDir);
      const filename = await createMigrationCommand({
        name: "cmd_git",
        listDir: path.join(repoDir, "list"),
        git: true,
      });

      const messages = logSpy.mock.calls.map((call) => String(call[1]));
      expect(messages.some((text) => text.includes(`Migration created: ${filename}`))).toBe(true);
      expect(messages.some((text) => text.includes(`Staged in git: ${filename}`))).toBe(true);
    } finally {
      logSpy.mockRestore();
      process.chdir(originalCwd);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("create command (CLI)", () => {
  it("exits 5 with a clear message for a traversal name and creates nothing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bunsql-cli-name-"));
    const dir = path.join(root, "list");
    try {
      const result = await runCli(["create", "../../pwned", "--dir", dir], envWithoutDatabaseUrl());
      expect(result.exitCode).toBe(5);
      expect(result.output).toContain("Invalid migration name");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 5 for a name with a path separator instead of a raw ENOENT", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bunsql-cli-name-"));
    const dir = path.join(root, "list");
    try {
      const result = await runCli(["create", "foo/bar", "--dir", dir], envWithoutDatabaseUrl());
      expect(result.exitCode).toBe(5);
      expect(result.output).toContain("Invalid migration name");
      expect(result.output).not.toContain("ENOENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 5 for an empty name", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bunsql-cli-name-"));
    const dir = path.join(root, "list");
    try {
      const result = await runCli(["create", "", "--dir", dir], envWithoutDatabaseUrl());
      expect(result.exitCode).toBe(5);
      expect(result.output).toContain("Empty argument is not allowed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a migration with a valid name and prints the created file name", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bunsql-cli-name-"));
    const dir = path.join(root, "list");
    try {
      const result = await runCli(["create", "add_users", "--dir", dir], envWithoutDatabaseUrl());
      expect(result.exitCode).toBe(0);
      const [created] = readdirSync(dir);
      expect(created).toMatch(/_add_users\.ts$/);
      expect(result.output).toContain(`Migration created: ${created}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
