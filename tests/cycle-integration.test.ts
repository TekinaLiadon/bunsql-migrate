import { describe, it, expect } from "bun:test";
import path from "node:path";

const url = process.env.DATABASE_URL ?? "";
const isRealDatabase = /^(postgres(ql)?|mariadb|mysql):\/\//.test(url);

describe.skipIf(!isRealDatabase)("full migration cycle against a real database", () => {
  it("runs install/up/down through the programmatic API in a fresh process", async () => {
    const runner = path.resolve(import.meta.dir, "cycle-runner.ts");
    const proc = Bun.spawn(["bun", runner], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;
    if (exitCode !== 0) {
      throw new Error(`cycle runner failed (exit ${exitCode}):\n${output}`);
    }
    expect(output).toContain("CYCLE-OK");
  }, 120000);
});

describe.skipIf(!isRealDatabase)("concurrent up runs against a real database", () => {
  it("serializes racing runs on the advisory lock and fast-fails on request", async () => {
    const runner = path.resolve(import.meta.dir, "lock-runner.ts");
    const proc = Bun.spawn(["bun", runner], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;
    if (exitCode !== 0) {
      throw new Error(`lock runner failed (exit ${exitCode}):\n${output}`);
    }
    expect(output).toContain("LOCK-OK");
  }, 60000);
});
