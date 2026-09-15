import { createDriver, type ExecutedMigration, type MigrationDriver } from "./core/driver.js";
import { migrateUp } from "./api/up.js";
import { migrateDown } from "./api/down.js";
import { installMigrations } from "./api/install.js";
import { createMigration } from "./api/create.js";
import {
  type MigrateDownResult,
  type MigrateOptions,
  type MigrateUpResult,
  ChecksumDriftError,
  GitStageError,
} from "./api/options.js";

export {
  createDriver,
  migrateUp,
  migrateDown,
  installMigrations,
  createMigration,
  ChecksumDriftError,
  GitStageError,
};
export type {
  ExecutedMigration,
  MigrationDriver,
  MigrateOptions,
  MigrateUpResult,
  MigrateDownResult,
};
