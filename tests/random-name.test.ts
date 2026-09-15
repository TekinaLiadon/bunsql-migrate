import { describe, it, expect } from "bun:test";
import { randomName } from "../src/core/random-name.js";

describe("randomName()", () => {
  it("generates a name in adjective_noun format", () => {
    const name = randomName();
    expect(name).toMatch(/^[a-z]+_[a-z]+$/);
  });

  it("contains the _ separator", () => {
    const name = randomName();
    const parts = name.split("_");
    expect(parts.length).toBe(2);
    expect(parts[0]!.length).toBeGreaterThan(0);
    expect(parts[1]!.length).toBeGreaterThan(0);
  });

  it("generates varied names (at least 2 distinct in 100 attempts)", () => {
    const names = new Set<string>();
    for (let i = 0; i < 100; i++) {
      names.add(randomName());
    }
    expect(names.size).toBeGreaterThan(1);
  });
});
