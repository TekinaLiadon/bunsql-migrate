import {
  ChecksumDriftError,
  InvalidMigrationNameError,
  MigrationLockError,
} from "../api/options.js";
import { InvalidIdentifierError } from "../core/identifiers.js";
import { InvalidConfigError } from "../core/config.js";

export const EXIT_SUCCESS = 0;
export const EXIT_GENERIC = 1;
export const EXIT_PENDING = 2;
export const EXIT_CHECKSUM_DRIFT = 3;
export const EXIT_LOCK_TIMEOUT = 4;
export const EXIT_USAGE = 5;

export function exitCodeForError(error: unknown): number {
  if (error instanceof ChecksumDriftError) {
    return EXIT_CHECKSUM_DRIFT;
  }
  if (error instanceof MigrationLockError) {
    return EXIT_LOCK_TIMEOUT;
  }
  if (
    error instanceof InvalidIdentifierError ||
    error instanceof InvalidConfigError ||
    error instanceof InvalidMigrationNameError
  ) {
    return EXIT_USAGE;
  }
  return EXIT_GENERIC;
}
