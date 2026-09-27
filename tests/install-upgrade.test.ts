import { describe, it, expect } from "bun:test";
import { createWhenMissing } from "../src/drivers/shared.js";

type DuplicateVariant =
  | "code-1060"
  | "code-er-dup-fieldname"
  | "code-1061"
  | "mysql-column"
  | "mysql-index"
  | "sqlite-column";

function duplicateError(variant: DuplicateVariant): Error {
  const byVariant: Record<DuplicateVariant, () => Error> = {
    "code-1060": () => Object.assign(new Error("add column failed"), { code: 1060 }),
    "code-er-dup-fieldname": () =>
      Object.assign(new Error("add column failed"), { code: "ER_DUP_FIELDNAME" }),
    "code-1061": () => Object.assign(new Error("create index failed"), { code: 1061 }),
    "mysql-column": () => new Error("Duplicate column name 'checksum'"),
    "mysql-index": () => new Error("Duplicate key name 'migrations_migration_unique'"),
    "sqlite-column": () => new Error("duplicate column name: checksum"),
  };
  return byVariant[variant]();
}

describe("createWhenMissing()", () => {
  it("skips the action when the probe already reports the object present", async () => {
    let actions = 0;
    await createWhenMissing(
      async () => true,
      async () => {
        actions += 1;
      },
    );
    expect(actions).toBe(0);
  });

  it("runs the action once when the probe reports the object missing", async () => {
    let actions = 0;
    await createWhenMissing(
      async () => false,
      async () => {
        actions += 1;
      },
    );
    expect(actions).toBe(1);
  });

  it("tolerates a lost duplicate race when the re-probe finds the object", async () => {
    for (const variant of [
      "code-1060",
      "code-er-dup-fieldname",
      "code-1061",
      "mysql-column",
      "mysql-index",
      "sqlite-column",
    ] as const) {
      let probes = 0;
      let actions = 0;
      await createWhenMissing(
        async () => {
          probes += 1;
          return probes > 1;
        },
        async () => {
          actions += 1;
          throw duplicateError(variant);
        },
      );
      expect(actions).toBe(1);
      expect(probes).toBe(2);
    }
  });

  it("rethrows a duplicate error when the re-probe still reports the object missing", async () => {
    let probes = 0;
    let actions = 0;
    await expect(
      createWhenMissing(
        async () => {
          probes += 1;
          return false;
        },
        async () => {
          actions += 1;
          throw duplicateError("mysql-column");
        },
      ),
    ).rejects.toThrow("Duplicate column name 'checksum'");
    expect(actions).toBe(1);
    expect(probes).toBe(2);
  });

  it("rethrows a non-duplicate error immediately without a re-probe", async () => {
    let probes = 0;
    await expect(
      createWhenMissing(
        async () => {
          probes += 1;
          return false;
        },
        async () => {
          throw new Error("table is locked");
        },
      ),
    ).rejects.toThrow("table is locked");
    expect(probes).toBe(1);
  });
});
