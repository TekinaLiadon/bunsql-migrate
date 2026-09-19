export type IdentifierKind = "table" | "schema";

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export class InvalidIdentifierError extends Error {
  readonly kind: IdentifierKind;
  readonly value: string;

  constructor(kind: IdentifierKind, value: string, maxLength: number) {
    super(
      `Invalid ${kind} name: "${value}" — expected an identifier of letters, digits, underscores and dollar signs ` +
        `starting with a letter or underscore, at most ${maxLength} characters`,
    );
    this.name = "InvalidIdentifierError";
    this.kind = kind;
    this.value = value;
  }
}

export function validateIdentifier(kind: IdentifierKind, value: string, maxLength: number): void {
  if (!IDENTIFIER_PATTERN.test(value) || value.length > maxLength) {
    throw new InvalidIdentifierError(kind, value, maxLength);
  }
}

export function doubleQuoted(name: string): string {
  return `"${name}"`;
}

export function backtickQuoted(name: string): string {
  return `\`${name}\``;
}
