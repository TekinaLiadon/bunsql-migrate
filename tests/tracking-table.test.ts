import { describe, it, expect } from "bun:test";
import type { MigrationDriver } from "../src/core/driver.js";
import { ensureTrackingTable, listExecutedForPlan } from "../src/api/tracking-table.js";

function makeDriverStub(overrides: Partial<MigrationDriver> = {}): MigrationDriver {
  return {
    install: async () => {},
    listExecuted: async () => [],
    record: async () => {},
    setChecksum: async () => {},
    remove: async () => {},
    transaction: async () => {
      throw new Error("transaction is not used in tracking-table stubs");
    },
    close: async () => {},
    ...overrides,
  };
}

describe("ensureTrackingTable()", () => {
  it("installs when the probe reports the table is not current", async () => {
    let installs = 0;
    const driver = makeDriverStub({
      install: async () => {
        installs += 1;
      },
      trackingTableCurrent: async () => false,
    });

    await ensureTrackingTable(driver);

    expect(installs).toBe(1);
  });

  it("skips install when the probe reports the table is current", async () => {
    let installs = 0;
    const driver = makeDriverStub({
      install: async () => {
        installs += 1;
      },
      trackingTableCurrent: async () => true,
    });

    await ensureTrackingTable(driver);

    expect(installs).toBe(0);
  });

  it("falls back to install when the driver has no probe", async () => {
    let installs = 0;
    const driver = makeDriverStub({
      install: async () => {
        installs += 1;
      },
    });

    await ensureTrackingTable(driver);

    expect(installs).toBe(1);
  });
});

describe("listExecutedForPlan()", () => {
  it("treats a database without the tracking table as empty history", async () => {
    const driver = makeDriverStub({
      trackingTableExists: async () => false,
      listExecuted: async () => [{ name: "1_should_not_be_read.js", checksum: "abc" }],
    });

    expect(await listExecutedForPlan(driver)).toEqual([]);
  });

  it("reads the history when the tracking table exists", async () => {
    const driver = makeDriverStub({
      trackingTableExists: async () => true,
      listExecuted: async () => [{ name: "1_applied.js", checksum: "abc" }],
    });

    expect(await listExecutedForPlan(driver)).toEqual([{ name: "1_applied.js", checksum: "abc" }]);
  });

  it("falls through to listExecuted when the driver has no probe", async () => {
    const driver = makeDriverStub({
      listExecuted: async () => [{ name: "1_applied.js", checksum: "abc" }],
    });

    expect(await listExecutedForPlan(driver)).toEqual([{ name: "1_applied.js", checksum: "abc" }]);
  });
});
