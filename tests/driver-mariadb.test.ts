import { describe, expect, it } from "bun:test";
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
});
