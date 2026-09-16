import { createDriver, type ExecutedMigration, type MigrationDriver } from "./core/driver.js";
import { migrateUp } from "./api/up.js";
import { migrateDown } from "./api/down.js";
import { migrateStatus } from "./api/status.js";
import { installMigrations } from "./api/install.js";
import { createMigration } from "./api/create.js";
import {
  type MigrateDownOptions,
  type MigrateDownResult,
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
  ChecksumDriftError,
  GitStageError,
  MigrationLockError,
  MigrationNotFoundError,
};
export type {
  ExecutedMigration,
  MigrationDriver,
  MigrateOptions,
  MigrateUpOptions,
  MigrateUpResult,
  MigrateDownOptions,
  MigrateDownResult,
  MigrateStatusResult,
};
