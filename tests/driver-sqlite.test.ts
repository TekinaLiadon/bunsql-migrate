import { describe, expect, it, afterAll } from "bun:test";
import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriver } from "../src/core/driver.js";

const tempDir = mkdtempSync(join(tmpdir(), "bunsql-migrate-sqlite-"));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("MigrationDriver — SQLite (integration)", () => {
  it("install/listExecuted/record/setChecksum/remove/close work against a file database", async () => {
    const driver = await createDriver(`sqlite://${join(tempDir, "cycle.db")}`);
    try {
      await driver.install();
      await driver.install();

      expect(await driver.listExecuted()).toEqual([]);

      await driver.record("0001-test", "checksum-1");
      await driver.record("0001-test", "checksum-duplicate");

      let executed = await driver.listExecuted();
      expect(executed).toEqual([{ name: "0001-test", checksum: "checksum-1" }]);

      await driver.record("0002-test", "checksum-2");
      executed = await driver.listExecuted();
      expect(executed.map((entry) => entry.name)).toEqual(["0001-test", "0002-test"]);

      await driver.setChecksum("0002-test", "checksum-2b");
      executed = await driver.listExecuted();
      expect(executed.find((entry) => entry.name === "0002-test")?.checksum).toBe("checksum-2b");

      await driver.remove("0002-test");
      expect(await driver.listExecuted()).toEqual([{ name: "0001-test", checksum: "checksum-1" }]);
    } finally {
      await driver.close();
    }
  });

  it("backfills a legacy record with a NULL checksum", async () => {
    const databaseUrl = `sqlite://${join(tempDir, "legacy.db")}`;
    const driver = await createDriver(databaseUrl);
    try {
      await driver.install();

      const legacy = new SQL(databaseUrl);
      await legacy`INSERT INTO migrations (migration, checksum) VALUES ('legacy-test', NULL)`;
      await legacy.close();

      const before = await driver.listExecuted();
      expect(before.find((entry) => entry.name === "legacy-test")?.checksum).toBeNull();

      await driver.setChecksum("legacy-test", "d".repeat(64));
      const after = await driver.listExecuted();
      expect(after.find((entry) => entry.name === "legacy-test")?.checksum).toBe("d".repeat(64));

      await driver.remove("legacy-test");
      expect(await driver.listExecuted()).toEqual([]);
    } finally {
      await driver.close();
    }
  });
});
