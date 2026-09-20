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
      return await attempt();
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new DatabaseWaitTimeoutError(timeoutSeconds, error);
      }
      if (!waitingLogged) {
        log({ text: `database is not ready — waiting up to ${timeoutSeconds}s`, type: "info" });
        waitingLogged = true;
      }
      await Bun.sleep(retryDelayMs);
    }
  }
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
