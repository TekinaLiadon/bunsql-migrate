import { noColorRequested } from "./env.js";

const colors = {
  success: "\x1b[32m%s\x1b[0m",
  warn: "\x1b[33m%s\x1b[0m",
  error: "\x1b[31m%s\x1b[0m",
  info: "%s",
} as const;

type LogLevel = keyof typeof colors;
type LogStream = "stdout" | "stderr";

const STREAM_BY_TYPE: Record<LogLevel, LogStream> = {
  success: "stdout",
  info: "stdout",
  warn: "stderr",
  error: "stderr",
};

interface LogOptions {
  text: string;
  type: LogLevel;
  stream?: LogStream;
  error?: unknown;
}

function emit(stream: LogStream, ...args: unknown[]): void {
  if (stream === "stdout") {
    console.log(...args);
    return;
  }
  console.error(...args);
}

function colorEnabled(stream: LogStream): boolean {
  const isTTY = stream === "stdout" ? process.stdout.isTTY : process.stderr.isTTY;
  return isTTY === true && !noColorRequested();
}

function formatError(error: unknown): void {
  if (error instanceof Error) {
    if (error.stack) {
      console.error(error.stack);
      return;
    }
    console.error(error.message);
    return;
  }
  if (typeof error !== "object" || error === null) {
    console.error(String(error));
    return;
  }
  if ("code" in error && "detail" in error) {
    formatTable(error as Record<string, unknown>);
    return;
  }
  if ("code" in error && "errno" in error) {
    console.error(error.code);
    console.error(error.errno);
    if ("byteOffset" in error) console.error(error.byteOffset);
    return;
  }
  if ("message" in error) {
    console.error(error.message);
    return;
  }
  console.error(String(error));
}

function formatTable(error: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(error)) {
    if (typeof value === "object" || value === undefined) continue;
    console.error(`${key}: ${String(value)}`);
  }
}

export function log({ text, type, stream, error = null }: LogOptions): void {
  const target = stream ?? STREAM_BY_TYPE[type];
  emit(target, colorEnabled(target) ? colors[type] : "%s", text);
  if (!error) return;
  formatError(error);
}
