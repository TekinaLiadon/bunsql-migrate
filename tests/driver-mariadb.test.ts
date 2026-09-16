import { describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { createDriver } from "../src/core/driver.js";

const { DATABASE_URL } = process.env;

function isMariaDbUrl(url: string | undefined): url is string {
  if (url === undefined) return false;
  try {
    return /^mariadb:|^mysql:/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

const itWithMariaDb = it.skipIf(!isMariaDbUrl(DATABASE_URL));

describe("MigrationDriver — MariaDB (integration)", () => {
  itWithMariaDb(
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

        await driver.setChecksum("0001-test", "checksum-2");
        executed = await driver.listExecuted();
        expect(executed[0]?.checksum).toBe("checksum-2");

        await driver.remove("0001-test");
        expect(await driver.listExecuted()).toEqual([]);
      } finally {
        await driver.close();
      }
    },
  );

  itWithMariaDb("upgrades a legacy migrations table without the checksum column", async () => {
    const baseUrl = new URL(DATABASE_URL as string);
    const legacyDb = `legacy_${Date.now()}`;
    baseUrl.pathname = `/${legacyDb}`;
    const legacyUrl = baseUrl.toString();

    const admin = new SQL(DATABASE_URL as string);
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${legacyDb}`);
      await admin.unsafe(`CREATE DATABASE ${legacyDb}`);
    } finally {
      admin.close({ timeout: 0 });
    }

    const legacy = new SQL(legacyUrl);
    try {
      await legacy`CREATE TABLE migrations (
        id INTEGER PRIMARY KEY AUTO_INCREMENT,
        migration VARCHAR(255) NOT NULL
      )`;
      await legacy`INSERT INTO migrations (migration) VALUES ('1_legacy.js')`;
    } finally {
      legacy.close({ timeout: 0 });
    }

    const driver = await createDriver(legacyUrl);
    try {
      await driver.install();
      expect(await driver.listExecuted()).toEqual([{ name: "1_legacy.js", checksum: null }]);
      await driver.remove("1_legacy.js");
      expect(await driver.listExecuted()).toEqual([]);
    } finally {
      await driver.close();
    }

    const cleanup = new SQL(DATABASE_URL as string);
    try {
      await cleanup.unsafe(`DROP DATABASE ${legacyDb}`);
    } finally {
      cleanup.close({ timeout: 0 });
    }
  });

  itWithMariaDb("transaction() commits and rolls back through the tx client", async () => {
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

  itWithMariaDb("tryLock/releaseLock provide mutual exclusion between connections", async () => {
    const first = await createDriver(DATABASE_URL as string);
    const second = await createDriver(DATABASE_URL as string);
    try {
      await first.install();
      await second.install();

      const { tryLock: lockFirst, releaseLock: unlockFirst } = first;
      const { tryLock: lockSecond, releaseLock: unlockSecond } = second;
      if (!lockFirst || !unlockFirst || !lockSecond || !unlockSecond) {
        throw new Error("mariadb driver must support the lock interface");
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
