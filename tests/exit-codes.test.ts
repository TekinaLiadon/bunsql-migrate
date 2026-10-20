import { describe, it, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  BunsqlMigrateError,
  ChecksumDriftError,
  DatabaseWaitTimeoutError,
  GitStageError,
  InvalidConfigError,
  InvalidIdentifierError,
  InvalidMigrationNameError,
  MigrationFileMissingError,
  MigrationLockError,
  MigrationNotFoundError,
  MigrationsDirectoryNotFoundError,
} from "../src/index.js";
import {
  EXIT_CHECKSUM_DRIFT,
  EXIT_GENERIC,
  EXIT_LOCK_TIMEOUT,
  EXIT_PENDING,
  EXIT_SUCCESS,
  EXIT_USAGE,
  exitCodeForError,
} from "../src/cli/exit-codes.js";
import { cliEnv, makeScenario, runCli, writeTableMigration, type Scenario } from "./helpers.js";

function envFor(scenario: Scenario): Record<string, string> {
  return cliEnv({
    databaseUrl: scenario.options.databaseUrl,
    listDir: scenario.options.listDir,
  });
}

function writeFailingMigration(listDir: string, file: string): void {
  writeFileSync(
    path.join(listDir, file),
    `const up = async (tx) => {
  await tx\`SELECT * FROM no_such_table\`;
};
const down = async (tx) => {};
export { up, down };
`,
  );
}

describe("exit code mapping", () => {
  it("maps each typed error to its own code", () => {
    expect(exitCodeForError(new ChecksumDriftError("1_a.js"))).toBe(EXIT_CHECKSUM_DRIFT);
    expect(exitCodeForError(new MigrationLockError(30))).toBe(EXIT_LOCK_TIMEOUT);
    expect(exitCodeForError(new InvalidIdentifierError("table", "nope!", 63))).toBe(EXIT_USAGE);
    expect(exitCodeForError(new Error("something else"))).toBe(EXIT_GENERIC);
  });

  it("maps the error category to the exit code", () => {
    expect(exitCodeForError(new BunsqlMigrateError("drift", "x"))).toBe(EXIT_CHECKSUM_DRIFT);
    expect(exitCodeForError(new BunsqlMigrateError("lock", "x"))).toBe(EXIT_LOCK_TIMEOUT);
    expect(exitCodeForError(new BunsqlMigrateError("usage", "x"))).toBe(EXIT_USAGE);
    expect(exitCodeForError(new BunsqlMigrateError("generic", "x"))).toBe(EXIT_GENERIC);
  });

  it("maps every typed error through its category", () => {
    expect(exitCodeForError(new InvalidConfigError("cfg.ts", "unknown key"))).toBe(EXIT_USAGE);
    expect(exitCodeForError(new InvalidMigrationNameError("bad name"))).toBe(EXIT_USAGE);
    expect(exitCodeForError(new MigrationsDirectoryNotFoundError("/nope"))).toBe(EXIT_USAGE);
    expect(exitCodeForError(new MigrationNotFoundError("1_a.js"))).toBe(EXIT_GENERIC);
    expect(exitCodeForError(new MigrationFileMissingError("1_a.js"))).toBe(EXIT_GENERIC);
    expect(exitCodeForError(new DatabaseWaitTimeoutError(1))).toBe(EXIT_GENERIC);
    expect(exitCodeForError(new GitStageError("1_a.js", 128, ""))).toBe(EXIT_GENERIC);
  });

  it("derives every typed error from BunsqlMigrateError", () => {
    const typed = [
      new ChecksumDriftError("1_a.js"),
      new MigrationNotFoundError("1_a.js"),
      new MigrationFileMissingError("1_a.js"),
      new MigrationLockError(30),
      new DatabaseWaitTimeoutError(1),
      new GitStageError("1_a.js", 1, "ignored"),
      new InvalidMigrationNameError("bad name"),
      new InvalidIdentifierError("table", "nope!", 63),
      new InvalidConfigError("cfg.ts", "unknown key"),
      new MigrationsDirectoryNotFoundError("/nope"),
    ];
    for (const error of typed) {
      expect(error).toBeInstanceOf(BunsqlMigrateError);
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("CLI exit codes", () => {
  it("exits 0 on success and on a clean status gate", async () => {
    const scenario = makeScenario("bunsql-exit-ok-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");

      const up = await runCli(["up"], envFor(scenario));
      expect(up.exitCode).toBe(EXIT_SUCCESS);

      const status = await runCli(["status", "--strict"], envFor(scenario));
      expect(status.exitCode).toBe(EXIT_SUCCESS);
    } finally {
      scenario.cleanup();
    }
  });

  it("exits 2 when migrations are pending under --strict", async () => {
    const scenario = makeScenario("bunsql-exit-pending-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");

      const status = await runCli(["status", "--strict"], envFor(scenario));
      expect(status.exitCode).toBe(EXIT_PENDING);
      expect(status.output).toContain("Strict mode");
    } finally {
      scenario.cleanup();
    }
  });

  it("exits 3 on a checksum drift", async () => {
    const scenario = makeScenario("bunsql-exit-drift-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "a_table");
      await runCli(["up"], envFor(scenario));
      writeTableMigration(scenario.listDir, "1_a.js", "a_table_v2");

      const up = await runCli(["up"], envFor(scenario));
      expect(up.exitCode).toBe(EXIT_CHECKSUM_DRIFT);
      expect(up.output).toContain("was modified after it was applied");
    } finally {
      scenario.cleanup();
    }
  });

  it("exits 5 on an invalid identifier and on a usage error", async () => {
    const scenario = makeScenario("bunsql-exit-usage-", "db.sqlite");
    try {
      const table = await runCli(["up", "--table", "not allowed!"], envFor(scenario));
      expect(table.exitCode).toBe(EXIT_USAGE);
      expect(table.output).toContain("Invalid table name");

      const strict = await runCli(["up", "--strict"], envFor(scenario));
      expect(strict.exitCode).toBe(EXIT_USAGE);
      expect(strict.output).toContain("up does not support --strict");
    } finally {
      scenario.cleanup();
    }
  });

  it("exits 5 on an unparseable or unsupported database URL", async () => {
    const scenario = makeScenario("bunsql-exit-url-", "db.sqlite");
    try {
      const malformed = await runCli(["up", "--url", "not a url"], envFor(scenario));
      expect(malformed.exitCode).toBe(EXIT_USAGE);
      expect(malformed.output).toContain("Cannot parse database URL");
      expect(malformed.output).not.toContain("Migration command failed");

      const unsupported = await runCli(["up", "--url", "oracle://localhost"], envFor(scenario));
      expect(unsupported.exitCode).toBe(EXIT_USAGE);
      expect(unsupported.output).toContain("Unsupported database URL protocol");
      expect(unsupported.output).not.toContain("Migration command failed");
    } finally {
      scenario.cleanup();
    }
  });

  it("exits 5 when a migration declares its tx parameter with a default", async () => {
    const scenario = makeScenario("bunsql-exit-arity-", "db.sqlite");
    try {
      writeFileSync(
        path.join(scenario.listDir, "1_default.js"),
        `const up = async (tx = sql) => {
  await tx\`SELECT 1\`;
};
export { up };
`,
      );

      const up = await runCli(["up"], envFor(scenario));

      expect(up.exitCode).toBe(EXIT_USAGE);
      expect(up.output).toContain("outside the migration transaction");
      expect(up.output).not.toContain("Migration command failed");
    } finally {
      scenario.cleanup();
    }
  });

  it("exits 1 on an unexpected failure", async () => {
    const scenario = makeScenario("bunsql-exit-generic-", "db.sqlite");
    try {
      writeFailingMigration(scenario.listDir, "1_a.js");

      const up = await runCli(["up"], envFor(scenario));
      expect(up.exitCode).toBe(EXIT_GENERIC);
      expect(up.output).toContain("migration failed");
    } finally {
      scenario.cleanup();
    }
  });
});
