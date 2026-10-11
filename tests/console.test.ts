import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { log } from "../src/core/console.js";
import { cliEnv, makeScenario, runCli, writeTableMigration } from "./helpers.js";

type ConsoleSpy = ReturnType<typeof spyOn<typeof console, "log">>;

let logSpy: ConsoleSpy;
let errorSpy: ConsoleSpy;

const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const originalStderrIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
let originalNoColor: string | undefined;

beforeEach(() => {
  logSpy = spyOn(console, "log");
  errorSpy = spyOn(console, "error");
  originalNoColor = process.env["NO_COLOR"];
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  restoreIsTTY(process.stdout, originalStdoutIsTTY);
  restoreIsTTY(process.stderr, originalStderrIsTTY);
  if (originalNoColor === undefined) {
    delete process.env["NO_COLOR"];
  } else {
    process.env["NO_COLOR"] = originalNoColor;
  }
});

function restoreIsTTY(
  stream: typeof process.stdout | typeof process.stderr,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    delete (stream as { isTTY?: boolean }).isTTY;
  } else {
    Object.defineProperty(stream, "isTTY", descriptor);
  }
}

function stubIsTTY(stream: "stdout" | "stderr", value: boolean): void {
  const target = stream === "stdout" ? process.stdout : process.stderr;
  Object.defineProperty(target, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

function logTexts(): string[] {
  return logSpy.mock.calls.flatMap((call) => call.map((arg) => String(arg)));
}

function errorTexts(): string[] {
  return errorSpy.mock.calls.flatMap((call) => call.map((arg) => String(arg)));
}

function firstLogArg(): string {
  return String(logSpy.mock.calls.at(-1)?.[0]);
}

function firstErrorArg(): string {
  return String(errorSpy.mock.calls.at(-1)?.[0]);
}

describe("log() streams", () => {
  it("routes info/success to stdout and warn/error to stderr", () => {
    log({ text: "data_info", type: "info" });
    log({ text: "data_success", type: "success" });
    log({ text: "diag_warn", type: "warn" });
    log({ text: "diag_error", type: "error" });
    expect(logTexts()).toContain("data_info");
    expect(logTexts()).toContain("data_success");
    expect(errorTexts()).toContain("diag_warn");
    expect(errorTexts()).toContain("diag_error");
    expect(logTexts()).not.toContain("diag_warn");
    expect(errorTexts()).not.toContain("data_info");
  });

  it("lets the caller force a stream (usage text goes to stderr)", () => {
    log({ text: "Usage: bunsql-native-migrate", type: "info", stream: "stderr" });
    expect(errorTexts()).toContain("Usage: bunsql-native-migrate");
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("log() colors", () => {
  it("prints the level color for success/info when stdout is a TTY", () => {
    stubIsTTY("stdout", true);
    log({ text: "msg_success", type: "success" });
    expect(firstLogArg()).toContain("\x1b[32m");
    expect(logTexts()).toContain("msg_success");
    log({ text: "msg_info", type: "info" });
    expect(firstLogArg()).toBe("%s");
    expect(logTexts()).toContain("msg_info");
  });

  it("prints the level color for warn/error when stderr is a TTY", () => {
    stubIsTTY("stderr", true);
    log({ text: "msg_warn", type: "warn" });
    expect(firstErrorArg()).toContain("\x1b[33m");
    expect(errorTexts()).toContain("msg_warn");
    log({ text: "msg_error", type: "error" });
    expect(firstErrorArg()).toContain("\x1b[31m");
    expect(errorTexts()).toContain("msg_error");
  });

  it("prints plain text when the target stream is not a TTY", () => {
    stubIsTTY("stdout", false);
    stubIsTTY("stderr", false);
    log({ text: "piped", type: "success" });
    expect(firstLogArg()).toBe("%s");
    expect(logTexts()).toContain("piped");

    log({ text: "piped-err", type: "error" });
    expect(firstErrorArg()).toBe("%s");
    expect(errorTexts()).toContain("piped-err");
  });

  it("colors follow the target stream, not stdout", () => {
    stubIsTTY("stdout", true);
    stubIsTTY("stderr", false);
    log({ text: "stderr-piped", type: "error" });
    expect(firstErrorArg()).toBe("%s");
    expect(errorTexts()).toContain("stderr-piped");
  });

  it("prints plain text when NO_COLOR is set, even on a TTY", () => {
    stubIsTTY("stdout", true);
    stubIsTTY("stderr", true);
    process.env["NO_COLOR"] = "1";
    log({ text: "no-color", type: "success" });
    expect(firstLogArg()).toBe("%s");
    expect(logTexts()).toContain("no-color");

    log({ text: "no-color-err", type: "error" });
    expect(firstErrorArg()).toBe("%s");
  });

  it("treats an empty NO_COLOR as not requested", () => {
    stubIsTTY("stdout", true);
    process.env["NO_COLOR"] = "";
    log({ text: "empty-no-color", type: "success" });
    expect(firstLogArg()).toContain("\x1b[32m");
  });
});

describe("log() error dumps", () => {
  it("prints an Error's message exactly once through the stack", () => {
    const error = new Error("failed badly");
    log({ text: "boom", type: "error", error });
    const joined = errorTexts().join("\n");
    expect(joined.split("failed badly").length - 1).toBe(1);
    expect(errorTexts().some((text) => text.includes("at "))).toBe(true);
  });

  it("prints the message once for an Error without a stack", () => {
    const error = new Error("no-stack");
    delete (error as { stack?: string }).stack;
    log({ text: "boom", type: "error", error });
    expect(errorTexts().join("\n").split("no-stack").length - 1).toBe(1);
  });

  it("prints key/value lines for errors with code and detail", () => {
    log({ text: "boom", type: "error", error: { code: "23505", detail: "duplicate key" } });
    expect(errorTexts()).toContain("code: 23505");
    expect(errorTexts()).toContain("detail: duplicate key");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("prints code and errno for driver-style errors", () => {
    log({ text: "boom", type: "error", error: { code: "ECONNREFUSED", errno: -111 } });
    expect(errorTexts()).toContain("ECONNREFUSED");
    expect(errorTexts()).toContain("-111");
  });

  it("prints byteOffset for errors that carry one", () => {
    log({ text: "boom", type: "error", error: { code: "ERR", errno: 1, byteOffset: 42 } });
    expect(errorTexts()).toContain("42");
  });

  it("prints the message for plain objects with a message", () => {
    log({ text: "boom", type: "error", error: { message: "just a message" } });
    expect(errorTexts()).toContain("just a message");
  });

  it("stringifies non-object errors", () => {
    log({ text: "boom", type: "error", error: "plain string error" });
    expect(errorTexts()).toContain("plain string error");

    log({ text: "boom", type: "error", error: 42 });
    expect(errorTexts()).toContain("42");
  });

  it("does not format anything when no error is given", () => {
    log({ text: "clean", type: "info" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logTexts()).toContain("clean");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("CLI stream separation", () => {
  it("keeps data on stdout and diagnostics on stderr", async () => {
    const scenario = makeScenario("bunsql-console-", "db.sqlite");
    try {
      writeTableMigration(scenario.listDir, "1_a.js", "console_table");
      const env = cliEnv({
        databaseUrl: scenario.options.databaseUrl,
        listDir: scenario.listDir,
      });

      const up = await runCli(["up"], env);
      expect(up.exitCode).toBe(0);
      expect(up.stdout).toContain("Applied 1 migration(s).");
      expect(up.stderr).toBe("");

      writeTableMigration(scenario.listDir, "2_b.js", "console_table_2");

      const status = await runCli(["status"], env);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("1_a.js applied");
      expect(status.stdout).toContain("1 applied, 1 pending");
      expect(status.stderr).toContain("2_b.js pending");

      writeTableMigration(scenario.listDir, "1_a.js", "console_table_v2");

      const drift = await runCli(["up"], env);
      expect(drift.exitCode).toBe(3);
      expect(drift.stdout).toBe("");
      expect(drift.stderr).toContain("was modified after it was applied");
    } finally {
      scenario.cleanup();
    }
  }, 10_000);

  it("prints usage to stderr and nothing to stdout on --help", async () => {
    const help = await runCli(["--help"], cliEnv());
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toBe("");
    expect(help.stderr).toContain("Usage:");
  });
});
