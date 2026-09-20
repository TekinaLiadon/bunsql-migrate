import { sql } from "bun";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set");
}

const prefix = `lock_${Date.now()}_`;
const table = `${prefix}t`;
const file = `9999999999999_${prefix}t.js`;

const dir = mkdtempSync(path.join(tmpdir(), "bunsql-lock-"));
const listDir = path.join(dir, "list");
const worker = path.join(import.meta.dir, "lock-worker.ts");

interface WorkerResult {
  code: number;
  output: string;
}

function spawnWorker(args: string[], stdin: "ignore" | "pipe" = "ignore") {
  return Bun.spawn(["bun", worker, ...args], {
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function collect(proc: ReturnType<typeof spawnWorker>): Promise<WorkerResult> {
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

async function readUntilMarker(
  proc: ReturnType<typeof spawnWorker>,
  marker: string,
  timeoutMs: number,
): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await reader.cancel();
      throw new Error(`marker "${marker}" not found in time, got: ${text}`);
    }
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => ({ timedOut: true })),
    ]);
    if ("timedOut" in chunk) {
      await reader.cancel();
      throw new Error(`marker "${marker}" not found in time, got: ${text}`);
    }
    if (chunk.done) {
      throw new Error(`worker output ended before marker "${marker}", got: ${text}`);
    }
    text += decoder.decode(chunk.value);
    if (text.includes(marker)) {
      await reader.cancel();
      return text;
    }
  }
}

async function countRows(query: string): Promise<number> {
  const rows = (await sql.unsafe(query)) as Array<{ n: number | string }>;
  return Number(rows[0]?.n);
}

function migrationFile(): string {
  return `import { sql } from "bun";
const up = async () => {
  await Bun.sleep(1500);
  await sql\`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT)\`;
  await sql\`INSERT INTO ${table} (id, name) VALUES (1, 'row')\`;
};
const down = async () => {
  await sql\`DROP TABLE ${table}\`;
};
export { up, down };
`;
}

try {
  mkdirSync(listDir, { recursive: true });
  writeFileSync(path.join(listDir, file), migrationFile());

  const raceFirst = spawnWorker(["--dir", listDir, "--delay", "0"]);
  const raceSecond = spawnWorker(["--dir", listDir, "--delay", "400"]);
  const [raceFirstResult, raceSecondResult] = await Promise.all([
    collect(raceFirst),
    collect(raceSecond),
  ]);
  if (raceFirstResult.code !== 0) {
    throw new Error(`first racing up failed: ${raceFirstResult.output}`);
  }
  if (raceSecondResult.code !== 0) {
    throw new Error(`second racing up failed: ${raceSecondResult.output}`);
  }

  const records = await countRows(
    `SELECT COUNT(*) AS n FROM migrations WHERE migration = '${file}'`,
  );
  if (records !== 1) {
    throw new Error(`expected exactly one tracking record, got ${records}`);
  }
  const appliedRows = await countRows(`SELECT COUNT(*) AS n FROM ${table}`);
  if (appliedRows !== 1) {
    throw new Error(`migration body did not run exactly once, table has ${appliedRows} rows`);
  }

  const holder = spawnWorker(["--dir", listDir, "--hold", "15000"], "pipe");
  await readUntilMarker(holder, "LOCK-HELD", 20000);

  const fast = await collect(spawnWorker(["--dir", listDir, "--lock-timeout", "0"]));
  if (fast.code !== 1 || !fast.output.includes("LOCK-BUSY")) {
    throw new Error(`fast-fail up did not fail with the lock error: ${JSON.stringify(fast)}`);
  }

  holder.stdin?.end();

  const waiter = await collect(spawnWorker(["--dir", listDir, "--delay", "0"]));
  if (waiter.code !== 0) {
    throw new Error(`waiting up failed: ${waiter.output}`);
  }

  const holderCode = await holder.exited;
  if (holderCode !== 0) {
    throw new Error(`lock holder failed (exit ${holderCode})`);
  }

  const recordsAfter = await countRows(
    `SELECT COUNT(*) AS n FROM migrations WHERE migration = '${file}'`,
  );
  if (recordsAfter !== 1) {
    throw new Error(`tracking record count changed after phase two: ${recordsAfter}`);
  }

  process.stdout.write("LOCK-OK\n");
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
  try {
    await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
    await sql.unsafe(`DELETE FROM migrations WHERE migration = '${file}'`);
  } catch {
    process.exitCode = 1;
  }
  rmSync(dir, { recursive: true, force: true });
}
