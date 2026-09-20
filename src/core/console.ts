const colors = {
  success: "\x1b[32m%s\x1b[0m",
  warn: "\x1b[33m%s\x1b[0m",
  error: "\x1b[31m%s\x1b[0m",
  info: "%s",
} as const;

type LogLevel = keyof typeof colors;

interface LogOptions {
  text: string;
  type: LogLevel;
  error?: unknown;
}

function formatError(error: unknown): void {
  if (error instanceof Error) {
    console.log(error.message);
    if (error.stack) console.log(error.stack);
    return;
  }
  if (typeof error !== "object" || error === null) {
    console.log(String(error));
    return;
  }
  if ("code" in error && "detail" in error) {
    console.table(error);
    return;
  }
  if ("code" in error && "errno" in error) {
    console.log(error.code);
    console.log(error.errno);
    if ("byteOffset" in error) console.log(error.byteOffset);
    return;
  }
  if ("message" in error) {
    console.log(error.message);
    return;
  }
  console.log(String(error));
}

export function log({ text, type, error = null }: LogOptions): void {
  console.log(colors[type], text);
  if (!error) return;
  formatError(error);
}
