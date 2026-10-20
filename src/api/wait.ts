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
  discardLateResult?: (value: T) => Promise<void>,
): Promise<T> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let waitingLogged = false;
  while (true) {
    try {
      return await attemptWithinDeadline(attempt, deadline, timeoutSeconds, discardLateResult);
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

async function attemptWithinDeadline<T>(
  attempt: () => Promise<T>,
  deadline: number,
  timeoutSeconds: number,
  discardLateResult: ((value: T) => Promise<void>) | undefined,
): Promise<T> {
  if (timeoutSeconds <= 0) {
    return attempt();
  }
  const pending = attempt();
  pending.catch(() => undefined);
  const expired = Bun.sleep(Math.max(deadline - Date.now(), 0)).then(() => "expired" as const);
  const outcome = await Promise.race([
    pending.then((value) => ({ status: "connected" as const, value })),
    expired.then((status) => ({ status })),
  ]);
  if (outcome.status === "connected") {
    return outcome.value;
  }
  if (discardLateResult !== undefined) {
    void pending.then((value) => discardLateResult(value)).catch(() => undefined);
  }
  throw new DatabaseWaitTimeoutError(
    timeoutSeconds,
    new Error("connection attempt still in progress"),
  );
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
  return waitForDatabase(
    () => connectProbed(databaseUrl, tableOptions),
    waitTimeout,
    WAIT_RETRY_DELAY_MS,
    (driver) => driver.close(),
  );
}
