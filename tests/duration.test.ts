import { describe, it, expect } from "bun:test";
import { formatDuration } from "../src/core/duration.js";

describe("formatDuration()", () => {
  it("formats sub-second durations as whole milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(120)).toBe("120ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("rounds fractional milliseconds", () => {
    expect(formatDuration(0.2)).toBe("0ms");
    expect(formatDuration(120.4)).toBe("120ms");
    expect(formatDuration(120.5)).toBe("121ms");
  });

  it("formats a second and longer as seconds with one decimal", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(12345)).toBe("12.3s");
    expect(formatDuration(61500)).toBe("61.5s");
  });

  it("promotes a fraction that rounds up to a full second", () => {
    expect(formatDuration(999.7)).toBe("1.0s");
    expect(formatDuration(999.4)).toBe("999ms");
  });
});
