export function formatDuration(durationMs: number): string {
  const roundedMs = Math.round(durationMs);
  if (roundedMs < 1000) {
    return `${roundedMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}
