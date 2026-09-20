import { describe, it, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { type SQL } from "bun";
import type { MigrationDriver } from "../src/core/driver.js";
import { runMigrationStep } from "../src/api/run-step.js";
import { migrateDown, migrateUp } from "../src/index.js";
import { makeScenario, readRecorded, readTables } from "./helpers.js";

function makeStepDriverStub(
  overrides: Partial<Pick<MigrationDriver, "transaction" | "client">>,
): MigrationDriver {
  return {
    install: async () => {},
    listExecuted: async () => [],
    record: async () => {},
    setChecksum: async () => {},
    remove: async () => {},
    close: async () => {},
    ...overrides,
  } as MigrationDriver;
}

describe("runMigrationStep noTransaction", () => {
  it("runs a marked step outside driver.transaction and passes it the driver client", async () => {
    const client = { tag: "client" } as unknown as SQL;
    const txClient = { tag: "tx" } as unknown as SQL;
    let transactionCalls = 0;
    let received: unknown = null;
    const driver = makeStepDriverStub({
      transaction: async <T>(run: (tx: SQL) => Promise<T>): Promise<T> => {
        transactionCalls += 1;
        return run(txClient);
      },
      client: () => client,
    });

    await runMigrationStep(driver, {
      step: async (tx) => void (received = tx),
      noTransaction: true,
    });

    expect(transactionCalls).toBe(0);
    expect(received).toBe(client);
  });

  it("still dispatches an unmarked step with a tx parameter through driver.transaction", async () => {
    const client = { tag: "client" } as unknown as SQL;
    const txClient = { tag: "tx" } as unknown as SQL;
    let transactionCalls = 0;
    let received: unknown = null;
    const driver = makeStepDriverStub({
      transaction: async <T>(run: (tx: SQL) => Promise<T>): Promise<T> => {
        transactionCalls += 1;
        return run(txClient);
      },
      client: () => client,
    });

    await runMigrationStep(driver, {
      step: async (tx) => void (received = tx),
      noTransaction: false,
    });

    expect(transactionCalls).toBe(1);
    expect(received).toBe(txClient);
  });

  it("throws a clear error when the driver exposes no non-transactional client", async () => {
    const driver = makeStepDriverStub({
      transaction: async <T>(): Promise<T> => {
        throw new Error("transaction must not be called");
      },
    });

    await expect(
      runMigrationStep(driver, { step: async () => {}, noTransaction: true }),
    ).rejects.toThrow(/noTransaction/);
  });
});

function writeNoTxMigration(listDir: string, file: string, table: string): void {
  writeFileSync(
    path.join(listDir, file),
    `const up = async (tx) => {
  await tx\`CREATE TABLE ${table} (id INTEGER)\`;
};
const down = async (tx) => {
  await tx\`DROP TABLE ${table}\`;
};
const noTransaction = true;
export { up, down, noTransaction };
`,
  );
}

describe("noTransaction migrations on sqlite", () => {
  it("applies a marked tx-arity migration through the driver client and records it", async () => {
    const scenario = makeScenario("bunsql-notx-");
    try {
      writeNoTxMigration(scenario.listDir, "1_marked.js", "marked_table");
      writeFileSync(
        path.join(scenario.listDir, "2_plain.js"),
        `const up = async (tx) => {
  await tx\`CREATE TABLE plain_table (id INTEGER)\`;
};
const down = async (tx) => {
  await tx\`DROP TABLE plain_table\`;
};
export { up, down };
`,
      );

      const result = await migrateUp(scenario.options);

      expect(result.applied).toEqual(["2_plain.js", "1_marked.js"]);
      expect(readTables(scenario.dbPath)).toContain("marked_table");
      expect(readTables(scenario.dbPath)).toContain("plain_table");
      expect(readRecorded(scenario.dbPath)).toEqual(["2_plain.js", "1_marked.js"]);
    } finally {
      scenario.cleanup();
    }
  });

  it("rolls a marked migration back through the driver client", async () => {
    const scenario = makeScenario("bunsql-notx-");
    try {
      writeNoTxMigration(scenario.listDir, "1_marked.js", "marked_table");
      await migrateUp(scenario.options);

      const result = await migrateDown(scenario.options);

      expect(result.reverted).toEqual(["1_marked.js"]);
      expect(readTables(scenario.dbPath)).not.toContain("marked_table");
      expect(readRecorded(scenario.dbPath)).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("applies a .up.sql with the no-transaction directive", async () => {
    const scenario = makeScenario("bunsql-notx-");
    try {
      writeFileSync(
        path.join(scenario.listDir, "1_concurrent.up.sql"),
        "-- bunsql-migrate:no-transaction\nCREATE TABLE concurrent_table (id INTEGER);\n",
      );
      writeFileSync(
        path.join(scenario.listDir, "1_concurrent.down.sql"),
        "-- bunsql-migrate:no-transaction\nDROP TABLE concurrent_table;\n",
      );

      const result = await migrateUp(scenario.options);

      expect(result.applied).toEqual(["1_concurrent.up.sql"]);
      expect(readTables(scenario.dbPath)).toContain("concurrent_table");

      const down = await migrateDown(scenario.options);

      expect(down.reverted).toEqual(["1_concurrent.up.sql"]);
      expect(readTables(scenario.dbPath)).not.toContain("concurrent_table");
    } finally {
      scenario.cleanup();
    }
  });

  it("ignores the directive outside the leading comment block", async () => {
    const scenario = makeScenario("bunsql-notx-");
    try {
      writeFileSync(
        path.join(scenario.listDir, "1_mid.up.sql"),
        "CREATE TABLE mid_table (id INTEGER);\n-- bunsql-migrate:no-transaction\n",
      );

      const result = await migrateUp(scenario.options);

      expect(result.applied).toEqual(["1_mid.up.sql"]);
      expect(readTables(scenario.dbPath)).toContain("mid_table");
    } finally {
      scenario.cleanup();
    }
  });
});
