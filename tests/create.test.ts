import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMigration, createMigrationCommand } from "../src/api/create.js";
import { GitStageError } from "../src/api/options.js";

const testDir = path.resolve(import.meta.dir, "__test_cli__");
const listDir = path.join(testDir, "list");

beforeAll(() => {
  mkdirSync(listDir, { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("createMigration()", () => {
  it("creates a migration with the given name", async () => {
    const filename = await createMigration({
      name: "my_migration",
      listDir,
    });
    expect(filename).toContain("my_migration.js");

    const files = readdirSync(listDir).filter((f) => f.endsWith(".js"));
    expect(files.length).toBe(1);
    expect(files[0]).toBe(filename);
  });

  it("creates a migration with a random name when none is given", async () => {
    const filename = await createMigration({ listDir });
    expect(filename).toMatch(/\.js$/);

    const files = readdirSync(listDir).filter((f) => f.endsWith(".js"));
    expect(files.length).toBe(2);
  });

  it("names the file with an inverted 13-digit timestamp and YYYY_MM_DD date", async () => {
    const filename = await createMigration({ name: "timestamp_test", listDir });
    expect(filename).toMatch(/^\d{13}_\d{4}_\d{2}_\d{2}_timestamp_test\.js$/);
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

      const files = readdirSync(collisionDir).filter((file) => file.endsWith("collision_check.js"));
      expect(files.length).toBe(8);
    } finally {
      rmSync(collisionDir, { recursive: true, force: true });
    }
  });

  it("creates a non-empty file (stub template)", async () => {
    const filename = await createMigration({ name: "stub_check", listDir });
    const content = await Bun.file(path.join(listDir, filename)).text();
    expect(content).toContain("up");
    expect(content).toContain("down");
    expect(content).not.toContain("sql``");
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
      expect(error.file).toContain("git_stage_fail.js");
      expect(error.message).toContain("git add failed");
      expect(error.message).toContain("ignored");

      const files = readdirSync(path.join(repoDir, "list"));
      expect(files.some((file) => file.endsWith("git_stage_fail.js"))).toBe(true);
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

describe("createMigrationCommand()", () => {
  it("creates the migration in the given list dir", async () => {
    const filename = await createMigrationCommand({ name: "cmd_explicit", listDir });
    expect(filename).toContain("cmd_explicit.js");
    expect(readdirSync(listDir)).toContain(filename);
  });

  it("falls back to MIGRATION_LIST_DIR when no listDir is given", async () => {
    const original = process.env["MIGRATION_LIST_DIR"];
    process.env["MIGRATION_LIST_DIR"] = listDir;
    try {
      const filename = await createMigrationCommand({ name: "cmd_env_dir" });
      expect(filename).toContain("cmd_env_dir.js");
      expect(readdirSync(listDir)).toContain(filename);
    } finally {
      if (original === undefined) {
        delete process.env["MIGRATION_LIST_DIR"];
      } else {
        process.env["MIGRATION_LIST_DIR"] = original;
      }
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
