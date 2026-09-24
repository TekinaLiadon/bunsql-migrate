import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSqliteFileLock, sqliteLockPath } from "../src/drivers/sqlite-lock.js";

let tempDir = "";

function makeTempDir(): string {
  tempDir = mkdtempSync(path.join(tmpdir(), "bunsql-sqlite-lock-"));
  return tempDir;
}

afterEach(() => {
  if (tempDir !== "") {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("sqliteLockPath()", () => {
  it("resolves the lock path next to the database file", () => {
    expect(sqliteLockPath("sqlite:/tmp/example.db")).toBe("/tmp/example.db.bunsql-migrate.lock");
    expect(sqliteLockPath("sqlite:///tmp/example.db")).toBe("/tmp/example.db.bunsql-migrate.lock");
  });

  it("resolves a relative database path against the cwd", () => {
    expect(sqliteLockPath("sqlite:relative.db")).toBe(
      `${path.resolve(process.cwd(), "relative.db")}.bunsql-migrate.lock`,
    );
  });

  it("ignores query strings", () => {
    expect(sqliteLockPath("sqlite:/tmp/example.db?cache=shared")).toBe(
      "/tmp/example.db.bunsql-migrate.lock",
    );
  });

  it("returns null for an in-memory database", () => {
    expect(sqliteLockPath("sqlite::memory:")).toBe(null);
    expect(sqliteLockPath("sqlite://:memory:")).toBe(null);
  });
});

describe("createSqliteFileLock()", () => {
  it("grants the lock to the first taker and makes the second one wait", async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "db.db.bunsql-migrate.lock");
    const first = createSqliteFileLock(lockPath);
    const second = createSqliteFileLock(lockPath);
    try {
      expect(await first.tryLock(5)).toBe(true);
      expect(await second.tryLock(5)).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      await first.releaseLock();
    }
  });

  it("is idempotent for the same lock instance", async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "db.db.bunsql-migrate.lock");
    const lock = createSqliteFileLock(lockPath);
    try {
      expect(await lock.tryLock(5)).toBe(true);
      expect(await lock.tryLock(5)).toBe(true);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      await lock.releaseLock();
    }
  });

  it("releases the lock so another instance can take it", async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "db.db.bunsql-migrate.lock");
    const first = createSqliteFileLock(lockPath);
    const second = createSqliteFileLock(lockPath);
    await first.tryLock(5);
    await first.releaseLock();
    expect(await second.tryLock(5)).toBe(true);
    await second.releaseLock();
  });

  it("removes the lock file on release", async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "db.db.bunsql-migrate.lock");
    const lock = createSqliteFileLock(lockPath);
    await lock.tryLock(5);
    await lock.releaseLock();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("steals a lock file left by a dead process", async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "db.db.bunsql-migrate.lock");
    const dead = Bun.spawn(["bun", "-e", "process.exit(0)"]);
    await dead.exited;
    writeFileSync(lockPath, String(dead.pid));

    const lock = createSqliteFileLock(lockPath);
    try {
      expect(await lock.tryLock(5)).toBe(true);
    } finally {
      await lock.releaseLock();
    }
  });

  it("steals a lock file without a readable owner PID", async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "db.db.bunsql-migrate.lock");
    for (const content of ["", "   ", "0"]) {
      writeFileSync(lockPath, content);

      const lock = createSqliteFileLock(lockPath);
      try {
        expect(await lock.tryLock(5)).toBe(true);
      } finally {
        await lock.releaseLock();
      }
      expect(existsSync(lockPath)).toBe(false);
    }
  });

  it("keeps waiting on a lock file held by a live process with unparseable content", async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "db.db.bunsql-migrate.lock");
    writeFileSync(lockPath, "garbage");

    const lock = createSqliteFileLock(lockPath);
    try {
      expect(await lock.tryLock(5)).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      await lock.releaseLock();
    }
  });

  it("cleans up the lock file from dispose when the run never released it", async () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "db.db.bunsql-migrate.lock");
    const lock = createSqliteFileLock(lockPath);
    await lock.tryLock(5);
    await lock.dispose();
    expect(existsSync(lockPath)).toBe(false);
  });
});
