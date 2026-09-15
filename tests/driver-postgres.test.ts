import { describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { createDriver } from "../src/core/driver.js";

const { DATABASE_URL } = process.env;

function isPostgresUrl(url: string | undefined): url is string {
  if (url === undefined) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "postgres:" || protocol === "postgresql:";
  } catch {
    return false;
  }
}

const itWithPostgres = it.skipIf(!isPostgresUrl(DATABASE_URL));

describe("MigrationDriver — Postgres (integration)", () => {
  itWithPostgres(
    "install/listExecuted/record/setChecksum/remove/close work against a real database",
    async () => {
      const driver = await createDriver(DATABASE_URL as string);
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
        await driver.remove("0001-test");
        expect(await driver.listExecuted()).toEqual([]);
      } finally {
        await driver.close();
      }
    },
  );

  itWithPostgres("backfills a legacy record with a NULL checksum", async () => {
    const driver = await createDriver(DATABASE_URL as string);
    try {
      await driver.install();

      const legacy = new SQL(DATABASE_URL as string);
      await legacy`INSERT INTO migrations (migration, checksum) VALUES ('legacy-test', NULL)`;
      await legacy.close();

      const before = await driver.listExecuted();
      expect(before.find((entry) => entry.name === "legacy-test")?.checksum).toBeNull();

      await driver.setChecksum("legacy-test", "e".repeat(64));
      const after = await driver.listExecuted();
      expect(after.find((entry) => entry.name === "legacy-test")?.checksum).toBe("e".repeat(64));

      await driver.remove("legacy-test");
      expect(await driver.listExecuted()).toEqual([]);
    } finally {
      await driver.close();
    }
  });
});
