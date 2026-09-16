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

  itWithPostgres("transaction() commits and rolls back through the tx client", async () => {
    const driver = await createDriver(DATABASE_URL as string);
    try {
      await driver.transaction(async (tx) => {
        await tx`DROP TABLE IF EXISTS driver_tx_probe`;
        await tx`CREATE TABLE driver_tx_probe (id INTEGER PRIMARY KEY, name TEXT)`;
        await tx`INSERT INTO driver_tx_probe (id, name) VALUES (1, 'one')`;
      });

      await expect(
        driver.transaction(async (tx) => {
          await tx`INSERT INTO driver_tx_probe (id, name) VALUES (2, 'rolled-back')`;
          throw new Error("tx-boom");
        }),
      ).rejects.toThrow("tx-boom");

      const rows = (await driver.transaction(
        (tx) => tx`SELECT COUNT(*) AS n FROM driver_tx_probe`,
      )) as Array<{ n: number | string }>;
      expect(Number(rows[0]?.n)).toBe(1);
      await driver.transaction((tx) => tx`DROP TABLE driver_tx_probe`);
    } finally {
      await driver.close();
    }
  });

  itWithPostgres("tryLock/releaseLock provide mutual exclusion between connections", async () => {
    const first = await createDriver(DATABASE_URL as string);
    const second = await createDriver(DATABASE_URL as string);
    try {
      await first.install();
      await second.install();

      const { tryLock: lockFirst, releaseLock: unlockFirst } = first;
      const { tryLock: lockSecond, releaseLock: unlockSecond } = second;
      if (!lockFirst || !unlockFirst || !lockSecond || !unlockSecond) {
        throw new Error("postgres driver must support the lock interface");
      }

      await expect(lockFirst(1)).resolves.toBe(true);
      await expect(lockSecond(1)).resolves.toBe(false);
      await unlockFirst();
      await expect(lockSecond(1)).resolves.toBe(true);
      await unlockSecond();
    } finally {
      await first.close();
      await second.close();
    }
  });
});
