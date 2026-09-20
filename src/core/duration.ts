export function resolveSecondsOption(
  option: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Invalid ${option}: ${String(value)} — expected a non-negative integer of seconds`,
    );
  }
  return value;
}

export function formatDuration(durationMs: number): string {
  const roundedMs = Math.round(durationMs);
  if (roundedMs < 1000) {
    return `${roundedMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}
