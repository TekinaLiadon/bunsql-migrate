import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { log } from "../src/core/console.js";

type ConsoleSpy = ReturnType<typeof spyOn<typeof console, "log">>;

let logSpy: ConsoleSpy;
let tableSpy: ConsoleSpy;

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
let originalNoColor: string | undefined;

beforeEach(() => {
  logSpy = spyOn(console, "log");
  tableSpy = spyOn(console, "table");
  originalNoColor = process.env["NO_COLOR"];
});

afterEach(() => {
  logSpy.mockRestore();
  tableSpy.mockRestore();
  if (originalIsTTY === undefined) {
    delete (process.stdout as { isTTY?: boolean }).isTTY;
  } else {
    Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  }
  if (originalNoColor === undefined) {
    delete process.env["NO_COLOR"];
  } else {
    process.env["NO_COLOR"] = originalNoColor;
  }
});

function stubIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

function logTexts(): string[] {
  return logSpy.mock.calls.flatMap((call) => call.map((arg) => String(arg)));
}

function firstArg(): string {
  return String(logSpy.mock.calls.at(-1)?.[0]);
}

describe("log() colors", () => {
  it("prints the level color when stdout is a TTY", () => {
    stubIsTTY(true);
    for (const [type, code] of [
      ["success", "\x1b[32m"],
      ["warn", "\x1b[33m"],
      ["error", "\x1b[31m"],
    ] as const) {
      log({ text: `msg_${type}`, type });
      expect(firstArg()).toContain(code);
      expect(logTexts()).toContain(`msg_${type}`);
    }
  });

  it("prints plain text when stdout is not a TTY", () => {
    stubIsTTY(false);
    log({ text: "piped", type: "success" });
    expect(firstArg()).toBe("%s");
    expect(logTexts()).toContain("piped");

    delete (process.stdout as { isTTY?: boolean }).isTTY;
    log({ text: "unknown-tty", type: "warn" });
    expect(firstArg()).toBe("%s");
    expect(logTexts()).toContain("unknown-tty");
  });

  it("prints plain text when NO_COLOR is set, even on a TTY", () => {
    stubIsTTY(true);
    process.env["NO_COLOR"] = "1";
    log({ text: "no-color", type: "success" });
    expect(firstArg()).toBe("%s");
    expect(logTexts()).toContain("no-color");
  });

  it("treats an empty NO_COLOR as not requested", () => {
    stubIsTTY(true);
    process.env["NO_COLOR"] = "";
    log({ text: "empty-no-color", type: "success" });
    expect(firstArg()).toContain("\x1b[32m");
  });
});

describe("log()", () => {
  it("prints the text for every level", () => {
    for (const type of ["success", "warn", "error", "info"] as const) {
      log({ text: `msg_${type}`, type });
      expect(logTexts()).toContain(`msg_${type}`);
    }
  });

  it("prints an Error's message exactly once through the stack", () => {
    const error = new Error("failed badly");
    log({ text: "boom", type: "error", error });
    const joined = logTexts().join("\n");
    expect(joined.split("failed badly").length - 1).toBe(1);
    expect(logTexts().some((text) => text.includes("at "))).toBe(true);
  });

  it("prints the message once for an Error without a stack", () => {
    const error = new Error("no-stack");
    delete (error as { stack?: string }).stack;
    log({ text: "boom", type: "error", error });
    expect(logTexts().join("\n").split("no-stack").length - 1).toBe(1);
  });

  it("prints a table for errors with code and detail", () => {
    log({ text: "boom", type: "error", error: { code: "23505", detail: "duplicate key" } });
    expect(tableSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("prints code and errno for driver-style errors", () => {
    log({ text: "boom", type: "error", error: { code: "ECONNREFUSED", errno: -111 } });
    expect(logTexts()).toContain("ECONNREFUSED");
    expect(logTexts()).toContain("-111");
  });

  it("prints byteOffset for errors that carry one", () => {
    log({ text: "boom", type: "error", error: { code: "ERR", errno: 1, byteOffset: 42 } });
    expect(logTexts()).toContain("42");
  });

  it("prints the message for plain objects with a message", () => {
    log({ text: "boom", type: "error", error: { message: "just a message" } });
    expect(logTexts()).toContain("just a message");
  });

  it("stringifies non-object errors", () => {
    log({ text: "boom", type: "error", error: "plain string error" });
    expect(logTexts()).toContain("plain string error");

    log({ text: "boom", type: "error", error: 42 });
    expect(logTexts()).toContain("42");
  });

  it("does not format anything when no error is given", () => {
    log({ text: "clean", type: "info" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logTexts()).toContain("clean");
    expect(tableSpy).not.toHaveBeenCalled();
  });
});
