import type { ExecutedMigration } from "../core/driver.js";

export interface MigrateOptions {
  databaseUrl?: string;
  listDir?: string;
  tableName?: string;
  schema?: string;
  waitTimeout?: number;
}

export interface MigrateUpOptions extends MigrateOptions {
  to?: string;
  lockTimeout?: number;
  dryRun?: boolean;
}

export interface MigrateDownOptions extends MigrateOptions {
  steps?: number | "all";
  to?: string;
  dryRun?: boolean;
}

export interface RedoOptions extends MigrateOptions {
  steps?: number;
  to?: string;
  lockTimeout?: number;
}

export interface MarkOptions extends MigrateOptions {
  to?: string;
}

export interface MigrateUpResult {
  applied: string[];
  planned?: string[];
}

export interface MigrateDownResult {
  reverted: string[];
  planned?: string[];
}

export interface RedoResult {
  reverted: string[];
  applied: string[];
}

export interface MarkResult {
  marked: string[];
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

export class MigrationFileMissingError extends Error {
  readonly file: string;

  constructor(file: string) {
    super(
      `${file} is missing from the migrations directory — restore the file or remove its tracking record manually`,
    );
    this.name = "MigrationFileMissingError";
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

export class DatabaseWaitTimeoutError extends Error {
  readonly timeoutSeconds: number;

  constructor(timeoutSeconds: number, cause?: unknown) {
    const reason = cause instanceof Error ? `: ${cause.message}` : "";
    super(`database was not ready within ${timeoutSeconds}s${reason}`);
    this.name = "DatabaseWaitTimeoutError";
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

export const MIGRATION_NAME_MAX_LENGTH = 128;

const MIGRATION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export class InvalidMigrationNameError extends Error {
  readonly value: string;

  constructor(value: string) {
    super(
      `Invalid migration name: "${value}" — expected letters, digits, hyphens and underscores only ` +
        `(no path separators, dots or spaces), at most ${MIGRATION_NAME_MAX_LENGTH} characters`,
    );
    this.name = "InvalidMigrationNameError";
    this.value = value;
  }
}

export function validateMigrationName(name: string): void {
  if (!MIGRATION_NAME_PATTERN.test(name) || name.length > MIGRATION_NAME_MAX_LENGTH) {
    throw new InvalidMigrationNameError(name);
  }
}
