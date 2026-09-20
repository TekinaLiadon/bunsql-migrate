import { describe, it, expect } from "bun:test";
import { DatabaseWaitTimeoutError } from "../src/index.js";
import { connectDriver, resolveWaitTimeout, waitForDatabase } from "../src/api/wait.js";
import { makeScenario, runCli } from "./helpers.js";

function flakyAttempt(failures: number): {
  attempt: () => Promise<string>;
  attempts: () => number;
} {
  let attempts = 0;
  return {
    attempt: async () => {
      attempts += 1;
      if (attempts <= failures) {
        throw new Error(`boom-${attempts}`);
      }
      return "connected";
    },
    attempts: () => attempts,
  };
}

describe("resolveWaitTimeout()", () => {
  it("defaults to zero (a single attempt, current behavior)", () => {
    expect(resolveWaitTimeout(undefined)).toBe(0);
  });

  it("accepts zero and positive integers", () => {
    expect(resolveWaitTimeout(0)).toBe(0);
    expect(resolveWaitTimeout(7)).toBe(7);
  });

  it("rejects negative, fractional and non-finite values", () => {
    expect(() => resolveWaitTimeout(-1)).toThrow(/waitTimeout/);
    expect(() => resolveWaitTimeout(1.5)).toThrow(/waitTimeout/);
    expect(() => resolveWaitTimeout(Number.NaN)).toThrow(/waitTimeout/);
    expect(() => resolveWaitTimeout(Number.POSITIVE_INFINITY)).toThrow(/waitTimeout/);
  });
});

describe("waitForDatabase()", () => {
  it("retries a failing attempt until it connects", async () => {
    const stub = flakyAttempt(2);

    const result = await waitForDatabase(stub.attempt, 5, 1);

    expect(result).toBe("connected");
    expect(stub.attempts()).toBe(3);
  });

  it("makes exactly one attempt when the timeout is zero", async () => {
    const stub = flakyAttempt(Number.POSITIVE_INFINITY);

    await expect(waitForDatabase(stub.attempt, 0, 1)).rejects.toBeInstanceOf(
      DatabaseWaitTimeoutError,
    );
    expect(stub.attempts()).toBe(1);
  });

  it("wraps the last error into DatabaseWaitTimeoutError when the deadline passes", async () => {
    const stub = flakyAttempt(Number.POSITIVE_INFINITY);

    const error = await waitForDatabase(stub.attempt, 1, 5).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DatabaseWaitTimeoutError);
    expect((error as DatabaseWaitTimeoutError).timeoutSeconds).toBe(1);
    expect((error as DatabaseWaitTimeoutError).message).toMatch(/was not ready within 1s: boom-/);
    expect(stub.attempts()).toBeGreaterThanOrEqual(2);
  });
});

describe("connectDriver()", () => {
  it("connects a sqlite database with a positive wait (probe passes)", async () => {
    const scenario = makeScenario("bunsql-wait-", "db.sqlite");
    try {
      const driver = await connectDriver(scenario.options.databaseUrl, {}, 5);
      await driver.close();
    } finally {
      scenario.cleanup();
    }
  });

  it("connects without probing when the wait is zero", async () => {
    const scenario = makeScenario("bunsql-wait-", "db.sqlite");
    try {
      const driver = await connectDriver(scenario.options.databaseUrl, {}, 0);
      await driver.close();
    } finally {
      scenario.cleanup();
    }
  });

  it("fails fast on a config error instead of waiting out the timeout", async () => {
    const error = await connectDriver("mysql2://user:pass@localhost/db", {}, 30).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).not.toBeInstanceOf(DatabaseWaitTimeoutError);
    expect((error as Error).message).toContain("Unsupported database URL protocol");
  });
});

describe("CLI --wait", () => {
  it("rejects invalid values with exit code 1", async () => {
    const scenario = makeScenario("bunsql-wait-cli-", "db.sqlite");
    try {
      const env = {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
      };

      for (const value of ["abc", "-1", "1.5"]) {
        const run = await runCli(["status", "--wait", value], env);
        expect(run.exitCode).toBe(1);
        expect(run.output).toContain("Invalid --wait");
      }

      const missing = await runCli(["status", "--wait"], env);
      expect(missing.exitCode).toBe(1);
      expect(missing.output).toContain("Invalid --wait");
    } finally {
      scenario.cleanup();
    }
  });

  it("keeps the single-attempt behavior for --wait 0", async () => {
    const scenario = makeScenario("bunsql-wait-cli-", "db.sqlite");
    try {
      const run = await runCli(["status", "--wait", "0"], {
        ...process.env,
        DATABASE_URL: scenario.options.databaseUrl,
        MIGRATION_LIST_DIR: scenario.listDir,
      });

      expect(run.exitCode).toBe(0);
    } finally {
      scenario.cleanup();
    }
  });

  it("waits, then reports a timeout for a database that never becomes ready", async () => {
    const run = await runCli(["status", "--url", "postgres://127.0.0.1:1/none", "--wait", "1"], {
      ...process.env,
      DATABASE_URL: "sqlite::memory:",
    });

    expect(run.exitCode).toBe(1);
    expect(run.output).toContain("was not ready within 1s");
  }, 10_000);
});
