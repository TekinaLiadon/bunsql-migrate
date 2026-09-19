import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const tsgoBin = path.join(repoRoot, "node_modules", ".bin", "tsgo");

const workDir = mkdtempSync(path.join(tmpdir(), "bunsql-pack-"));
const projectDir = path.join(workDir, "consumer");
let tgzPath = "";

beforeAll(async () => {
  const pkg = await Bun.file(path.join(repoRoot, "package.json")).json();
  const packed = Bun.spawnSync(["bun", "pm", "pack", "--quiet"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (packed.exitCode !== 0) {
    throw new Error(`bun pm pack failed: ${packed.stderr.toString()}`);
  }
  const repoTgz = path.join(repoRoot, `${pkg.name}-${pkg.version}.tgz`);
  tgzPath = path.join(workDir, path.basename(repoTgz));
  renameSync(repoTgz, tgzPath);

  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, "package.json"), '{"name":"bunsql-smoke","private":true}\n');
  const installed = await run(["bun", "add", tgzPath], { cwd: projectDir });
  if (installed.exitCode !== 0) {
    throw new Error(`bun add tarball failed: ${installed.output}`);
  }
}, 30000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
  for (const leftover of new Bun.Glob("bunsql-native-migrate-*.tgz").scanSync({ cwd: repoRoot })) {
    rmSync(path.join(repoRoot, leftover), { force: true });
  }
});

interface RunResult {
  exitCode: number;
  output: string;
}

async function run(
  cmd: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

describe("pack smoke test (tarball as a consumer sees it)", () => {
  it("ships exactly the published files: package.json, README, LICENSE, src/", () => {
    const packed = Bun.spawnSync(["tar", "-tzf", tgzPath], { stdout: "pipe", stderr: "pipe" });
    expect(packed.exitCode).toBe(0);
    const entries = packed.stdout
      .toString()
      .split("\n")
      .map((entry) => entry.replace(/^package\//, "").trimEnd())
      .filter((entry) => entry.length > 0);

    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "src/index.ts",
      "src/cli/main.ts",
    ]) {
      expect(entries).toContain(required);
    }
    const allowed = /^(package\.json|README\.md|LICENSE|src\/.+)$/;
    const junk = entries.filter((entry) => !allowed.test(entry));
    expect(junk).toEqual([]);
  });

  it("survives npm manifest normalization: bin is kept, no auto-corrections", async () => {
    const dryRun = Bun.spawnSync(["npm", "publish", "--dry-run"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${dryRun.stdout}\n${dryRun.stderr}`;
    const pkg = await Bun.file(path.join(repoRoot, "package.json")).json();
    expect(output).toContain(pkg.version);
    expect(output).not.toContain("invalid and removed");
    expect(output).not.toContain("auto-corrected");
  });

  it("runs the full CLI cycle against sqlite from the installed package", async () => {
    const env = { DATABASE_URL: `sqlite:${path.join(projectDir, "smoke.db")}` };
    const cli = ["bun", "x", "bunsql-native-migrate"];

    const help = await run([...cli, "--help"], { cwd: projectDir, env });
    expect(help.exitCode).toBe(0);
    expect(help.output).toContain("Usage: bunsql-native-migrate");

    const init = await run([...cli, "init", "--dir", "list"], {
      cwd: projectDir,
      env,
    });
    expect(init.exitCode).toBe(0);
    expect(init.output).toContain("Migration created:");
    expect(init.output).toContain("initial.ts");
    expect(init.output).toContain("DATABASE_URL");

    const createdJs = await run([...cli, "create", "smoke_js", "--lang", "js", "--dir", "list"], {
      cwd: projectDir,
      env,
    });
    expect(createdJs.exitCode).toBe(0);
    expect(createdJs.output).toContain("Migration created:");

    const strictPending = await run([...cli, "status", "--dir", "list", "--strict"], {
      cwd: projectDir,
      env,
    });
    expect(strictPending.exitCode).toBe(1);
    expect(strictPending.output).toContain("Strict mode: 2 pending migration(s).");

    expect(
      (await run([...cli, "install", "--dir", "list"], { cwd: projectDir, env })).exitCode,
    ).toBe(0);

    const up = await run([...cli, "up", "--dir", "list"], { cwd: projectDir, env });
    expect(up.exitCode).toBe(0);
    expect(up.output).toContain("Applied 2 migration(s).");

    const upAgain = await run([...cli, "up", "--dir", "list"], { cwd: projectDir, env });
    expect(upAgain.exitCode).toBe(0);
    expect(upAgain.output).toContain("No pending migrations.");

    const status = await run([...cli, "status", "--dir", "list"], { cwd: projectDir, env });
    expect(status.exitCode).toBe(0);
    expect(status.output).toContain("2 applied, 0 pending");

    const strictClean = await run([...cli, "status", "--dir", "list", "--strict"], {
      cwd: projectDir,
      env,
    });
    expect(strictClean.exitCode).toBe(0);

    const down = await run([...cli, "down", "--dir", "list"], { cwd: projectDir, env });
    expect(down.exitCode).toBe(0);
    expect(down.output).toContain("rolled back");

    const down2 = await run([...cli, "down", "--dir", "list"], { cwd: projectDir, env });
    expect(down2.exitCode).toBe(0);
    expect(down2.output).toContain("rolled back");

    const downAgain = await run([...cli, "down", "--dir", "list"], { cwd: projectDir, env });
    expect(downAgain.exitCode).toBe(0);
    expect(downAgain.output).toContain("No migrations to rollback.");
    expect(downAgain.output).not.toContain("Nothing to revert.");
  }, 60000);

  it("executes the programmatic API from the installed package", async () => {
    writeFileSync(
      path.join(projectDir, "api-smoke.ts"),
      `import {
  migrateUp,
  migrateDown,
  migrateStatus,
  installMigrations,
  createMigration,
  createDriver,
  ChecksumDriftError,
  GitStageError,
} from "bunsql-native-migrate";

await installMigrations({ listDir: "./api-list" });
const filename = await createMigration({ name: "api_probe", listDir: "./api-list" });
const first = await migrateUp({ listDir: "./api-list" });
const { reverted } = await migrateDown({ listDir: "./api-list" });
const status = await migrateStatus({ listDir: "./api-list" });
const driver = await createDriver(process.env.DATABASE_URL!);
const executed = await driver.listExecuted();
await driver.close();

if (typeof ChecksumDriftError !== "function" || typeof GitStageError !== "function") {
  throw new Error("error classes missing from the installed package");
}
if (
  first.applied.length !== 1 ||
  !Array.isArray(reverted) ||
  reverted.length !== 1 ||
  !filename.endsWith("api_probe.ts") ||
  status.applied.length !== 0 ||
  status.pending.length !== 1 ||
  status.pending[0] !== filename
) {
  throw new Error(\`unexpected API results: \${first.applied.length}, \${reverted}, \${filename}, \${JSON.stringify(status)}\`);
}
console.log("API-SMOKE-OK", executed.length);
`,
    );

    const result = await run(["bun", "api-smoke.ts"], {
      cwd: projectDir,
      env: { DATABASE_URL: `sqlite:${path.join(projectDir, "api.db")}` },
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("API-SMOKE-OK");
  }, 60000);

  it("resolves the published types (exports.types) with tsgo — and fails on a missing export", async () => {
    writeFileSync(
      path.join(projectDir, "types-probe.ts"),
      `import {
  type MigrateUpResult,
  type MigrateStatusResult,
  migrateUp,
  migrateStatus,
} from "bunsql-native-migrate";

const result: MigrateUpResult = await migrateUp({ databaseUrl: "sqlite:./types-probe.db" });
const applied: string[] = result.applied;
const status: MigrateStatusResult = await migrateStatus({ databaseUrl: "sqlite:./types-probe.db" });
console.log(applied.length, status.pending.length);
`,
    );
    writeFileSync(
      path.join(projectDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "esnext",
          module: "esnext",
          moduleResolution: "bundler",
          types: ["node", "bun-types"],
          typeRoots: [
            path.join(repoRoot, "node_modules", "@types"),
            path.join(repoRoot, "node_modules"),
          ],
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["types-probe.ts"],
      }),
    );

    const valid = await run([tsgoBin, "--noEmit", "-p", projectDir], { cwd: projectDir });
    expect(valid.exitCode).toBe(0);

    writeFileSync(
      path.join(projectDir, "broken-import.ts"),
      `import { DoesNotExist } from "bunsql-native-migrate";\nconsole.log(DoesNotExist);\n`,
    );
    writeFileSync(
      path.join(projectDir, "tsconfig.broken.json"),
      JSON.stringify({
        compilerOptions: {
          target: "esnext",
          module: "esnext",
          moduleResolution: "bundler",
          types: ["node", "bun-types"],
          typeRoots: [
            path.join(repoRoot, "node_modules", "@types"),
            path.join(repoRoot, "node_modules"),
          ],
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["broken-import.ts"],
      }),
    );

    const broken = await run(
      [tsgoBin, "--noEmit", "-p", path.join(projectDir, "tsconfig.broken.json")],
      {
        cwd: projectDir,
      },
    );
    expect(broken.exitCode).not.toBe(0);
    expect(broken.output).toContain("DoesNotExist");
  }, 60000);
});
