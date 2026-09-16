import { log } from "../core/console.js";
import type { MigrationDriver } from "../core/driver.js";
import { MigrationLockError } from "./options.js";

export const DEFAULT_LOCK_TIMEOUT_SECONDS = 30;

const LOCK_RETRY_DELAY_MS = 100;

export function resolveLockTimeout(lockTimeout: number | undefined): number {
  if (lockTimeout === undefined) return DEFAULT_LOCK_TIMEOUT_SECONDS;
  if (!Number.isInteger(lockTimeout) || lockTimeout < 0) {
    throw new Error(
      `Invalid lockTimeout: ${String(lockTimeout)} — expected a non-negative integer of seconds`,
    );
  }
  return lockTimeout;
}

export async function withMigrationLock<T>(
  driver: MigrationDriver,
  timeoutSeconds: number,
  run: () => Promise<T>,
): Promise<T> {
  const { tryLock, releaseLock } = driver;
  if (tryLock === undefined || releaseLock === undefined) {
    return run();
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  let waitingLogged = false;
  while (!(await tryLock(timeoutSeconds))) {
    if (Date.now() >= deadline) {
      throw new MigrationLockError(timeoutSeconds);
    }
    if (!waitingLogged) {
      log({ text: "another migrate up holds the lock — waiting", type: "info" });
      waitingLogged = true;
    }
    await Bun.sleep(LOCK_RETRY_DELAY_MS);
  }

  try {
    const result = await run();
    await releaseLock();
    return result;
  } catch (error) {
    await releaseLock().catch(() => undefined);
    throw error;
  }
}
