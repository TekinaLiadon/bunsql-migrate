import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listFiles, resolveListDir, DEFAULT_MIGRATIONS_DIR } from "../src/core/fs.js";

const testDir = path.resolve(import.meta.dir, "__test_files__");

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("listFiles()", () => {
  it("finds .js files in a directory", async () => {
    writeFileSync(path.join(testDir, "a.js"), "");
    writeFileSync(path.join(testDir, "b.js"), "");
    writeFileSync(path.join(testDir, "c.txt"), "");

    const files = await listFiles(testDir, ["js"]);
    expect(files).toHaveLength(2);
    expect(files).toContain("a.js");
    expect(files).toContain("b.js");
    expect(files).not.toContain("c.txt");
  });

  it("collects .js and .ts in one list sorted by name", async () => {
    const mixedDir = path.join(testDir, "mixed");
    mkdirSync(mixedDir, { recursive: true });
    writeFileSync(path.join(mixedDir, "1_first.js"), "");
    writeFileSync(path.join(mixedDir, "2_second.ts"), "");
    writeFileSync(path.join(mixedDir, "3_third.js"), "");
    writeFileSync(path.join(mixedDir, "notes.txt"), "");

    const files = await listFiles(mixedDir, ["js", "ts"]);
    expect(files).toEqual(["3_third.js", "2_second.ts", "1_first.js"]);
  });

  it("returns an empty array for an empty directory", async () => {
    const emptyDir = path.join(testDir, "empty");
    mkdirSync(emptyDir, { recursive: true });

    const files = await listFiles(emptyDir, ["js"]);
    expect(files).toHaveLength(0);
  });
});

describe("resolveListDir()", () => {
  it("prefers the explicit override", () => {
    expect(resolveListDir("/custom/dir")).toBe("/custom/dir");
  });

  it("always returns an absolute path", () => {
    expect(path.isAbsolute(resolveListDir())).toBe(true);
    expect(path.isAbsolute(resolveListDir("migrations"))).toBe(true);
    expect(path.isAbsolute(resolveListDir("/custom/dir"))).toBe(true);
  });

  it("resolves a relative override against the process cwd", () => {
    expect(resolveListDir("migrations")).toBe(path.join(process.cwd(), "migrations"));
    expect(resolveListDir("./list/custom")).toBe(path.join(process.cwd(), "list", "custom"));
  });

  it("honors MIGRATION_LIST_DIR", () => {
    const previous = process.env["MIGRATION_LIST_DIR"];
    process.env["MIGRATION_LIST_DIR"] = path.join(testDir, "custom-list");
    try {
      expect(resolveListDir()).toBe(path.join(testDir, "custom-list"));
    } finally {
      if (previous === undefined) {
        delete process.env["MIGRATION_LIST_DIR"];
      } else {
        process.env["MIGRATION_LIST_DIR"] = previous;
      }
    }
  });

  it("resolves a relative MIGRATION_LIST_DIR against the process cwd", () => {
    const previous = process.env["MIGRATION_LIST_DIR"];
    process.env["MIGRATION_LIST_DIR"] = "list/custom";
    try {
      expect(resolveListDir()).toBe(path.join(process.cwd(), "list", "custom"));
    } finally {
      if (previous === undefined) {
        delete process.env["MIGRATION_LIST_DIR"];
      } else {
        process.env["MIGRATION_LIST_DIR"] = previous;
      }
    }
  });

  it("falls back to <cwd>/migrations", () => {
    const previous = process.env["MIGRATION_LIST_DIR"];
    delete process.env["MIGRATION_LIST_DIR"];
    try {
      expect(resolveListDir()).toBe(path.join(process.cwd(), DEFAULT_MIGRATIONS_DIR));
    } finally {
      if (previous !== undefined) {
        process.env["MIGRATION_LIST_DIR"] = previous;
      }
    }
  });
});
