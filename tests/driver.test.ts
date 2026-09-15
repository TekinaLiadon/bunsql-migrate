import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDriver } from "../src/core/driver.js";

const SQLITE_URL = "sqlite://:memory:";

let driver: Awaited<ReturnType<typeof createDriver>>;

beforeAll(async () => {
  driver = await createDriver(SQLITE_URL);
  await driver.install();
});

afterAll(async () => {
  await driver.close();
});

describe("createDriver() — SQLite", () => {
  it("creates a driver from a sqlite:// URL", () => {
    expect(driver).toBeDefined();
  });

  it("rejects an unsupported URL protocol", async () => {
    expect(createDriver("oracle://localhost")).rejects.toThrow("Unsupported database URL protocol");
  });

  it("rejects an unparseable URL", async () => {
    expect(createDriver("not a url")).rejects.toThrow("Cannot parse database URL");
  });
});

describe("MigrationDriver.install()", () => {
  it("creates the migrations table (idempotent)", async () => {
    await driver.install();
    const executed = await driver.listExecuted();
    expect(executed).toEqual([]);
  });
});

describe("MigrationDriver.record() + listExecuted()", () => {
  it("records a migration with its checksum and lists it", async () => {
    await driver.record("2025_01_01_120000_test.js", "a".repeat(64));
    const executed = await driver.listExecuted();
    expect(executed.map((entry) => entry.name)).toContain("2025_01_01_120000_test.js");

    const recorded = executed.find((entry) => entry.name === "2025_01_01_120000_test.js");
    expect(recorded?.checksum).toBe("a".repeat(64));
  });

  it("does not duplicate a migration on repeated record (UNIQUE)", async () => {
    await driver.record("2025_01_01_120000_test.js", "a".repeat(64));
    const executed = await driver.listExecuted();
    expect(executed.filter((entry) => entry.name === "2025_01_01_120000_test.js")).toHaveLength(1);
  });

  it("returns migrations in id ASC order", async () => {
    await driver.record("2025_01_01_120001_second.js", "b".repeat(64));
    const executed = await driver.listExecuted();
    expect(executed[0]?.name).toBe("2025_01_01_120000_test.js");
    expect(executed[1]?.name).toBe("2025_01_01_120001_second.js");
  });
});

describe("MigrationDriver.setChecksum()", () => {
  it("backfills the checksum of a legacy record", async () => {
    await driver.setChecksum("2025_01_01_120001_second.js", "c".repeat(64));
    const executed = await driver.listExecuted();
    const updated = executed.find((entry) => entry.name === "2025_01_01_120001_second.js");
    expect(updated?.checksum).toBe("c".repeat(64));
  });
});

describe("MigrationDriver.remove()", () => {
  it("removes a single migration from the tracking table", async () => {
    await driver.remove("2025_01_01_120001_second.js");
    const executed = await driver.listExecuted();
    expect(executed.map((entry) => entry.name)).not.toContain("2025_01_01_120001_second.js");
    expect(executed.map((entry) => entry.name)).toContain("2025_01_01_120000_test.js");
  });
});

describe("MigrationDriver.close()", () => {
  it("closes the connection without errors", async () => {
    await driver.close();
    expect(true).toBe(true);
  });
});

describe("MigrationDriver.install() — legacy table", () => {
  it("adds the checksum column to a legacy migrations table", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bunsql-driver-legacy-"));
    try {
      const dbPath = path.join(dir, "legacy.db");
      const db = new Database(dbPath);
      try {
        db.query(
          "CREATE TABLE migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, migration TEXT NOT NULL)",
        ).run();
        db.query("INSERT INTO migrations (migration) VALUES ('1_legacy.js')").run();
      } finally {
        db.close();
      }

      const legacyDriver = await createDriver(`sqlite:${dbPath}`);
      try {
        await legacyDriver.install();
        const executed = await legacyDriver.listExecuted();
        expect(executed).toEqual([{ name: "1_legacy.js", checksum: null }]);
      } finally {
        await legacyDriver.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createDriver() — driver dispatch", () => {
  it("creates a postgres driver from a postgres:// URL without connecting", async () => {
    const postgresDriver = await createDriver("postgres://user:pass@localhost:5432/db");
    try {
      expect(typeof postgresDriver.install).toBe("function");
      expect(typeof postgresDriver.listExecuted).toBe("function");
      expect(typeof postgresDriver.record).toBe("function");
      expect(typeof postgresDriver.setChecksum).toBe("function");
      expect(typeof postgresDriver.remove).toBe("function");
      expect(typeof postgresDriver.close).toBe("function");
    } finally {
      await postgresDriver.close();
    }
  });

  it("creates a mariadb driver from a mariadb:// URL without connecting", async () => {
    const mariadbDriver = await createDriver("mariadb://user:pass@localhost:3306/db");
    try {
      expect(typeof mariadbDriver.install).toBe("function");
      expect(typeof mariadbDriver.listExecuted).toBe("function");
      expect(typeof mariadbDriver.record).toBe("function");
      expect(typeof mariadbDriver.setChecksum).toBe("function");
      expect(typeof mariadbDriver.remove).toBe("function");
      expect(typeof mariadbDriver.close).toBe("function");
    } finally {
      await mariadbDriver.close();
    }
  });
});
