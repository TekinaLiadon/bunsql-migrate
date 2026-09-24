import { link, open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SqlLock } from "./shared.js";

const LOCK_FILE_SUFFIX = ".bunsql-migrate.lock";

const IN_MEMORY_PATH = ":memory:";

export function sqliteLockPath(databaseUrl: string): string | null {
  const withoutScheme = databaseUrl.replace(/^sqlite:/, "");
  const withoutAuthority = withoutScheme.startsWith("//") ? withoutScheme.slice(2) : withoutScheme;
  const filePath = withoutAuthority.split(/[?#]/)[0]!;
  if (filePath === IN_MEMORY_PATH) return null;
  return `${path.resolve(filePath)}${LOCK_FILE_SUFFIX}`;
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  let content: string;
  try {
    content = (await readFile(lockPath, "utf8")).trim();
  } catch {
    return false;
  }
  const pid = Number(content);
  if (!Number.isInteger(pid)) return false;
  if (pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function tryCreateLockFile(lockPath: string): Promise<boolean> {
  const stagingPath = `${lockPath}.${randomUUID()}.tmp`;
  const handle = await open(stagingPath, "wx");
  try {
    await handle.writeFile(String(process.pid));
  } finally {
    await handle.close();
  }
  try {
    await link(stagingPath, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await lockIsStale(lockPath))) return false;
    await unlink(lockPath).catch(() => undefined);
    return tryCreateLockFile(lockPath);
  } finally {
    await unlink(stagingPath).catch(() => undefined);
  }
}

export function createSqliteFileLock(lockPath: string): SqlLock {
  let held = false;
  return {
    async tryLock() {
      if (held) return true;
      if (await tryCreateLockFile(lockPath)) {
        held = true;
        return true;
      }
      return false;
    },
    async releaseLock() {
      if (!held) return;
      held = false;
      await unlink(lockPath).catch(() => undefined);
    },
    async dispose() {
      if (!held) return;
      held = false;
      await unlink(lockPath).catch(() => undefined);
    },
  };
}

export function createInMemoryLock(): SqlLock {
  return {
    tryLock: async () => true,
    releaseLock: async () => {},
    dispose() {},
  };
}
