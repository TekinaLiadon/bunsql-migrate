import {
  createDriver,
  type DriverTableOptions,
  type ExecutedMigration,
  type MigrationDriver,
} from "./core/driver.js";
import { InvalidIdentifierError } from "./core/identifiers.js";
import { migrateUp } from "./api/up.js";
import { migrateDown } from "./api/down.js";
import { migrateRedo } from "./api/redo.js";
import { migrateStatus } from "./api/status.js";
import { installMigrations } from "./api/install.js";
import { createMigration } from "./api/create.js";
import { markMigrationsApplied } from "./api/mark.js";
import {
  type MigrateDownOptions,
  type MigrateDownResult,
  type MarkOptions,
  type MarkResult,
  type MigrateOptions,
  type MigrateStatusResult,
  type MigrateUpOptions,
  type MigrateUpResult,
  type RedoOptions,
  type RedoResult,
  ChecksumDriftError,
  DatabaseWaitTimeoutError,
  GitStageError,
  MigrationLockError,
  MigrationNotFoundError,
} from "./api/options.js";

export {
  createDriver,
  migrateUp,
  migrateDown,
  migrateRedo,
  migrateStatus,
  installMigrations,
  createMigration,
  markMigrationsApplied,
  ChecksumDriftError,
  DatabaseWaitTimeoutError,
  GitStageError,
  InvalidIdentifierError,
  MigrationLockError,
  MigrationNotFoundError,
};
export type {
  DriverTableOptions,
  ExecutedMigration,
  MigrationDriver,
  MigrateOptions,
  MigrateUpOptions,
  MigrateUpResult,
  MigrateDownOptions,
  MigrateDownResult,
  RedoOptions,
  RedoResult,
  MarkOptions,
  MarkResult,
  MigrateStatusResult,
};
