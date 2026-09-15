const colors = {
  success: "\x1b[32m%s\x1b[0m",
  warn: "\x1b[33m%s\x1b[0m",
  error: "\x1b[31m%s\x1b[0m",
  info: "",
} as const;

type LogLevel = keyof typeof colors;

interface LogOptions {
  text: string;
  type: LogLevel;
  error?: unknown;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function formatError(error: any): void {
  if (error instanceof Error) {
    console.log(error.message);
    if (error.stack) console.log(error.stack);
    return;
  }
  if (typeof error === "object" && error !== null) {
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
  }
  console.log(String(error));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function log({ text, type, error = null }: LogOptions): void {
  console.log(colors[type], text);
  if (!error) return;
  formatError(error);
}
