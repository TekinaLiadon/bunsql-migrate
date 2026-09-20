import { describe, it, expect } from "bun:test";
import { type SQL } from "bun";
import type { MigrationDriver } from "../src/core/driver.js";
import {
  DEFAULT_LOCK_TIMEOUT_SECONDS,
  resolveLockTimeout,
  withMigrationLock,
} from "../src/api/lock.js";
import { MigrationLockError } from "../src/api/options.js";
import { createReservedLock } from "../src/drivers/shared.js";

function makeDriverStub(
  overrides: Partial<Pick<MigrationDriver, "tryLock" | "releaseLock">>,
): MigrationDriver {
  return {
    install: async () => {},
    listExecuted: async () => [],
    record: async () => {},
    setChecksum: async () => {},
    remove: async () => {},
    transaction: async () => {
      throw new Error("transaction is not used in lock stubs");
    },
    close: async () => {},
    ...overrides,
  };
}

function makeLockStub(results: boolean[]): {
  driver: MigrationDriver;
  attempts: () => number;
  releases: () => number;
} {
  let attempts = 0;
  let releases = 0;
  return {
    attempts: () => attempts,
    releases: () => releases,
    driver: makeDriverStub({
      tryLock: async () => {
        const result = results[Math.min(attempts, results.length - 1)];
        attempts += 1;
        return result ?? false;
      },
      releaseLock: async () => {
        releases += 1;
      },
    }),
  };
}

describe("resolveLockTimeout()", () => {
  it("defaults to 30 seconds", () => {
    expect(resolveLockTimeout(undefined)).toBe(DEFAULT_LOCK_TIMEOUT_SECONDS);
    expect(DEFAULT_LOCK_TIMEOUT_SECONDS).toBe(30);
  });

  it("accepts zero and positive integers", () => {
    expect(resolveLockTimeout(0)).toBe(0);
    expect(resolveLockTimeout(7)).toBe(7);
  });

  it("rejects negative, fractional and non-finite values", () => {
    expect(() => resolveLockTimeout(-1)).toThrow(/lockTimeout/);
    expect(() => resolveLockTimeout(1.5)).toThrow(/lockTimeout/);
    expect(() => resolveLockTimeout(Number.NaN)).toThrow(/lockTimeout/);
    expect(() => resolveLockTimeout(Number.POSITIVE_INFINITY)).toThrow(/lockTimeout/);
  });
});

describe("withMigrationLock()", () => {
  it("runs the callback once and releases the lock on success", async () => {
    const stub = makeLockStub([true]);

    const result = await withMigrationLock(stub.driver, 30, async () => "applied");

    expect(result).toBe("applied");
    expect(stub.attempts()).toBe(1);
    expect(stub.releases()).toBe(1);
  });

  it("retries until the lock is acquired", async () => {
    const stub = makeLockStub([false, false, true]);

    const result = await withMigrationLock(stub.driver, 2, async () => "done");

    expect(result).toBe("done");
    expect(stub.attempts()).toBe(3);
    expect(stub.releases()).toBe(1);
  });

  it("throws MigrationLockError without releasing when the timeout expires", async () => {
    const stub = makeLockStub([false]);

    await expect(withMigrationLock(stub.driver, 0, async () => "never")).rejects.toBeInstanceOf(
      MigrationLockError,
    );

    expect(stub.attempts()).toBe(1);
    expect(stub.releases()).toBe(0);
  });

  it("releases the lock when the run throws and rethrows the original error", async () => {
    const stub = makeLockStub([true]);

    await expect(
      withMigrationLock(stub.driver, 30, async () => {
        throw new Error("migration-boom");
      }),
    ).rejects.toThrow("migration-boom");

    expect(stub.releases()).toBe(1);
  });

  it("swallows a release failure when the run itself failed", async () => {
    const driver = makeDriverStub({
      tryLock: async () => true,
      releaseLock: async () => {
        throw new Error("release-boom");
      },
    });

    await expect(
      withMigrationLock(driver, 30, async () => {
        throw new Error("migration-boom");
      }),
    ).rejects.toThrow("migration-boom");
  });

  it("propagates a release failure after a successful run", async () => {
    const driver = makeDriverStub({
      tryLock: async () => true,
      releaseLock: async () => {
        throw new Error("release-boom");
      },
    });

    await expect(withMigrationLock(driver, 30, async () => "done")).rejects.toThrow("release-boom");
  });

  it("runs without locking when the driver has no lock support", async () => {
    const bare = makeDriverStub({});

    await expect(withMigrationLock(bare, 30, async () => "ok")).resolves.toBe("ok");
  });
});

describe("createReservedLock()", () => {
  it("treats a repeated tryLock as already held without reserving again", async () => {
    const connections: Array<{ released: boolean; release(): void }> = [];
    const db = {
      reserve: async () => {
        const connection = {
          released: false,
          release() {
            this.released = true;
          },
        };
        connections.push(connection);
        return connection;
      },
    };
    const lock = createReservedLock(
      db as unknown as SQL,
      async () => true,
      async () => undefined,
    );

    expect(await lock.tryLock(1)).toBe(true);
    expect(await lock.tryLock(1)).toBe(true);
    expect(connections).toHaveLength(1);

    await lock.releaseLock();
    expect(connections[0]?.released).toBe(true);

    expect(await lock.tryLock(1)).toBe(true);
    expect(connections).toHaveLength(2);
  });
});
