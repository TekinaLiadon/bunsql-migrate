import { createDriver, type MigrationDriver, migrateUp, MigrationLockError } from "../src/index.js";

interface WorkerArgs {
  dir: string;
  delay: number;
  lockTimeout?: number;
  holdMs?: number;
}

function parseArgs(argv: string[]): WorkerArgs {
  let dir = "";
  let delay = 0;
  let lockTimeout: number | undefined;
  let holdMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") {
      dir = argv[++i] ?? "";
    } else if (arg === "--delay") {
      delay = Number(argv[++i] ?? 0);
    } else if (arg === "--lock-timeout") {
      lockTimeout = Number(argv[++i]);
    } else if (arg === "--hold") {
      holdMs = Number(argv[++i]);
    }
  }
  return {
    dir,
    delay,
    ...(lockTimeout !== undefined ? { lockTimeout } : {}),
    ...(holdMs !== undefined ? { holdMs } : {}),
  };
}

function stdinClosed(): Promise<void> {
  return new Response(Bun.stdin).text().then(() => undefined);
}

async function holdLock(driver: MigrationDriver, capMs: number): Promise<never> {
  await driver.install();
  const { tryLock, releaseLock } = driver;
  if (tryLock === undefined || releaseLock === undefined) {
    process.stdout.write("HOLD-UNSUPPORTED\n");
    process.exit(1);
  }
  if (!(await tryLock(30))) {
    process.stdout.write("HOLD-BUSY\n");
    process.exit(1);
  }
  process.stdout.write("LOCK-HELD\n");
  await Promise.race([stdinClosed(), Bun.sleep(capMs)]);
  await releaseLock();
  await driver.close();
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set");
}

if (args.holdMs !== undefined) {
  const driver = await createDriver(url);
  await holdLock(driver, args.holdMs);
}
if (args.delay > 0) {
  await Bun.sleep(args.delay);
}

try {
  await migrateUp({
    listDir: args.dir,
    ...(args.lockTimeout !== undefined ? { lockTimeout: args.lockTimeout } : {}),
  });
  process.stdout.write("UP-OK\n");
  process.exit(0);
} catch (error) {
  if (error instanceof MigrationLockError) {
    process.stdout.write("LOCK-BUSY\n");
    process.exit(1);
  }
  process.stdout.write(`UP-FAILED ${String(error)}\n`);
  process.exit(1);
}
