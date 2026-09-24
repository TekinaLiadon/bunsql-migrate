import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { log } from "../src/core/console.js";

type ConsoleSpy = ReturnType<typeof spyOn<typeof console, "log">>;

let logSpy: ConsoleSpy;
let tableSpy: ConsoleSpy;

beforeEach(() => {
  logSpy = spyOn(console, "log");
  tableSpy = spyOn(console, "table");
});

afterEach(() => {
  logSpy.mockRestore();
  tableSpy.mockRestore();
});

function logTexts(): string[] {
  return logSpy.mock.calls.flatMap((call) => call.map((arg) => String(arg)));
}

describe("log()", () => {
  it("prints the text with the chosen level color", () => {
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
