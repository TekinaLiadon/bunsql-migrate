import { log } from "../core/console.js";
import { createDriver, type DriverTableOptions, type MigrationDriver } from "../core/driver.js";
import { resolveSecondsOption } from "../core/duration.js";
import { DatabaseWaitTimeoutError } from "./options.js";

export const WAIT_RETRY_DELAY_MS = 500;

export function resolveWaitTimeout(waitTimeout: number | undefined): number {
  return resolveSecondsOption("waitTimeout", waitTimeout, 0);
}

export async function waitForDatabase<T>(
  attempt: () => Promise<T>,
  timeoutSeconds: number,
  retryDelayMs: number = WAIT_RETRY_DELAY_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let waitingLogged = false;
  while (true) {
    try {
      return await attemptWithinDeadline(attempt, deadline, timeoutSeconds);
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error instanceof DatabaseWaitTimeoutError
          ? error
          : new DatabaseWaitTimeoutError(timeoutSeconds, error);
      }
      if (!waitingLogged) {
        log({ text: `database is not ready — waiting up to ${timeoutSeconds}s`, type: "info" });
        waitingLogged = true;
      }
      await Bun.sleep(retryDelayMs);
    }
  }
}

function attemptWithinDeadline<T>(
  attempt: () => Promise<T>,
  deadline: number,
  timeoutSeconds: number,
): Promise<T> {
  if (timeoutSeconds <= 0) {
    return attempt();
  }
  const pending = attempt();
  pending.catch(() => undefined);
  const expired = Bun.sleep(Math.max(deadline - Date.now(), 0)).then(() => {
    throw new DatabaseWaitTimeoutError(
      timeoutSeconds,
      new Error("connection attempt still in progress"),
    );
  });
  expired.catch(() => undefined);
  return Promise.race([pending, expired]);
}

async function connectProbed(
  databaseUrl: string,
  tableOptions: DriverTableOptions,
): Promise<MigrationDriver> {
  const driver = await createDriver(databaseUrl, tableOptions);
  try {
    await driver.transaction(async () => {});
    return driver;
  } catch (error) {
    await driver.close().catch(() => undefined);
    throw error;
  }
}

async function assertDriverConfig(
  databaseUrl: string,
  tableOptions: DriverTableOptions,
): Promise<void> {
  const driver = await createDriver(databaseUrl, tableOptions);
  await driver.close();
}

export async function connectDriver(
  databaseUrl: string,
  tableOptions: DriverTableOptions,
  waitTimeout: number,
): Promise<MigrationDriver> {
  if (waitTimeout <= 0) {
    return createDriver(databaseUrl, tableOptions);
  }
  await assertDriverConfig(databaseUrl, tableOptions);
  return waitForDatabase(() => connectProbed(databaseUrl, tableOptions), waitTimeout);
}
