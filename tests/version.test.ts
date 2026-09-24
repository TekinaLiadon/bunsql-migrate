import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cliEnv, runCli } from "./helpers.js";

const pkg = JSON.parse(
  readFileSync(path.resolve(import.meta.dir, "..", "package.json"), "utf8"),
) as {
  version: string;
};

describe("CLI version", () => {
  it("--version prints the package version without DATABASE_URL", async () => {
    const run = await runCli(["--version"], cliEnv());

    expect(run.exitCode).toBe(0);
    expect(run.output.trim()).toBe(pkg.version);
    expect(run.output).not.toContain("DATABASE_URL is not set");
  });

  it("the version command prints the package version without DATABASE_URL", async () => {
    const run = await runCli(["version"], cliEnv());

    expect(run.exitCode).toBe(0);
    expect(run.output.trim()).toBe(pkg.version);
  });

  it("--version does not open a database connection", async () => {
    const run = await runCli(["--version"], {
      ...cliEnv(),
      DATABASE_URL: "postgres://127.0.0.1:1/no-connection-please",
    });

    expect(run.exitCode).toBe(0);
    expect(run.output.trim()).toBe(pkg.version);
  });

  it("--version wins over a command", async () => {
    const run = await runCli(["up", "--version"], cliEnv());

    expect(run.exitCode).toBe(0);
    expect(run.output.trim()).toBe(pkg.version);
  });
});
