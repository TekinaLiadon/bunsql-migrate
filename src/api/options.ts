export interface MigrateOptions {
  databaseUrl?: string;
  listDir?: string;
}

export interface MigrateUpResult {
  applied: string[];
}

export interface MigrateDownResult {
  reverted: string | null;
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
