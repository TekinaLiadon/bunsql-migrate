export type MigrationErrorCategory = "drift" | "lock" | "usage" | "generic";

export class BunsqlMigrateError extends Error {
  readonly category: MigrationErrorCategory;

  constructor(category: MigrationErrorCategory, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BunsqlMigrateError";
    this.category = category;
  }
}

export function errorCode(error: unknown): unknown {
  if (error !== null && typeof error === "object" && "code" in error) {
    return (error as { code: unknown }).code;
  }
  return undefined;
}
