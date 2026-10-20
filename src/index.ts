import {
  createDriver,
  type DriverTableOptions,
  type ExecutedMigration,
  type MigrationDriver,
} from "./core/driver.js";
import { BunsqlMigrateError, type MigrationErrorCategory } from "./core/error.js";
import { InvalidIdentifierError } from "./core/identifiers.js";
import { InvalidConfigError, loadProjectConfig, type ProjectConfig } from "./core/config.js";
import {
  MigrationsDirectoryNotFoundError,
  MigrationsDirectoryNotADirectoryError,
} from "./core/fs.js";
import { migrateUp } from "./api/up.js";
import { migrateDown } from "./api/down.js";
import { migrateRedo } from "./api/redo.js";
import { migrateStatus } from "./api/status.js";
import { installMigrations, type InstallOptions } from "./api/install.js";
import { createMigration, type CreateOptions, type MigrationLang } from "./api/create.js";
import { initMigrations, type InitOptions, type InitResult } from "./api/init.js";
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
  InvalidMigrationNameError,
  InvalidMigrationRecordError,
  MigrationFileMissingError,
  MigrationLockError,
  MigrationNotFoundError,
} from "./api/options.js";

export {
  createDriver,
  loadProjectConfig,
  migrateUp,
  migrateDown,
  migrateRedo,
  migrateStatus,
  installMigrations,
  createMigration,
  initMigrations,
  markMigrationsApplied,
  BunsqlMigrateError,
  ChecksumDriftError,
  DatabaseWaitTimeoutError,
  GitStageError,
  InvalidConfigError,
  InvalidIdentifierError,
  InvalidMigrationNameError,
  InvalidMigrationRecordError,
  MigrationFileMissingError,
  MigrationLockError,
  MigrationNotFoundError,
  MigrationsDirectoryNotFoundError,
  MigrationsDirectoryNotADirectoryError,
};
export type {
  DriverTableOptions,
  ExecutedMigration,
  MigrationDriver,
  MigrationErrorCategory,
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
  CreateOptions,
  MigrationLang,
  InstallOptions,
  InitOptions,
  InitResult,
  ProjectConfig,
};
