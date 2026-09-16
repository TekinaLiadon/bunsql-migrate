import type { ExecutedMigration } from "../core/driver.js";

export interface MigrateOptions {
  databaseUrl?: string;
  listDir?: string;
}

export interface MigrateUpOptions extends MigrateOptions {
  to?: string;
  lockTimeout?: number;
}

export interface MigrateDownOptions extends MigrateOptions {
  steps?: number | "all";
}

export interface MigrateUpResult {
  applied: string[];
}

export interface MigrateDownResult {
  reverted: string[];
}

export interface MigrateStatusResult {
  applied: ExecutedMigration[];
  pending: string[];
}

export class ChecksumDriftError extends Error {
  readonly file: string;

  constructor(file: string) {
    super(
      `${file} was modified after it was applied — restore the file or resolve the drift manually`,
    );
    this.name = "ChecksumDriftError";
    this.file = file;
  }
}

export class MigrationNotFoundError extends Error {
  readonly file: string;

  constructor(file: string) {
    super(`${file} is not in the migrations directory — nothing was applied`);
    this.name = "MigrationNotFoundError";
    this.file = file;
  }
}

export class MigrationLockError extends Error {
  readonly timeoutSeconds: number;

  constructor(timeoutSeconds: number) {
    super(
      `could not acquire the migration lock within ${timeoutSeconds}s — another migrate up is probably still running`,
    );
    this.name = "MigrationLockError";
    this.timeoutSeconds = timeoutSeconds;
  }
}

export class GitStageError extends Error {
  readonly file: string;
  readonly exitCode: number;

  constructor(file: string, exitCode: number, reason: string) {
    super(
      `git add failed for ${file} (exit code ${exitCode})` +
        `${reason ? `: ${reason}` : ""} — the file was created but is not staged`,
    );
    this.name = "GitStageError";
    this.file = file;
    this.exitCode = exitCode;
  }
}
