import {
  createDriver,
  type DriverTableOptions,
  type ExecutedMigration,
  type MigrationDriver,
} from "./core/driver.js";
import { InvalidIdentifierError } from "./core/identifiers.js";
import { migrateUp } from "./api/up.js";
import { migrateDown } from "./api/down.js";
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
  ChecksumDriftError,
  GitStageError,
  MigrationLockError,
  MigrationNotFoundError,
} from "./api/options.js";

export {
  createDriver,
  migrateUp,
  migrateDown,
  migrateStatus,
  installMigrations,
  createMigration,
  markMigrationsApplied,
  ChecksumDriftError,
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
  MarkOptions,
  MarkResult,
  MigrateStatusResult,
};
