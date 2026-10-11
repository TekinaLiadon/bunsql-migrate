import { BunsqlMigrateError } from "../core/error.js";

export const EXIT_SUCCESS = 0;
export const EXIT_GENERIC = 1;
export const EXIT_PENDING = 2;
export const EXIT_CHECKSUM_DRIFT = 3;
export const EXIT_LOCK_TIMEOUT = 4;
export const EXIT_USAGE = 5;

export function exitCodeForError(error: unknown): number {
  if (!(error instanceof BunsqlMigrateError)) {
    return EXIT_GENERIC;
  }
  switch (error.category) {
    case "drift":
      return EXIT_CHECKSUM_DRIFT;
    case "lock":
      return EXIT_LOCK_TIMEOUT;
    case "usage":
      return EXIT_USAGE;
    default:
      return EXIT_GENERIC;
  }
}
