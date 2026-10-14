import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { listFiles, resolveListDir, checksumFile, DEFAULT_MIGRATIONS_DIR } from "../src/core/fs.js";
import {
  createDriver,
  installMigrations,
  migrateStatus,
  migrateUp,
  ChecksumDriftError,
} from "../src/index.js";
import { makeScenario, readChecksums, readTables } from "./helpers.js";

const testDir = path.resolve(import.meta.dir, "__test_files__");

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("listFiles()", () => {
  it("finds migration files in a directory", async () => {
    writeFileSync(path.join(testDir, "a.js"), "");
    writeFileSync(path.join(testDir, "b.js"), "");
    writeFileSync(path.join(testDir, "c.txt"), "");

    const files = await listFiles(testDir);
    expect(files).toHaveLength(2);
    expect(files).toContain("a.js");
    expect(files).toContain("b.js");
    expect(files).not.toContain("c.txt");
  });

  it("collects .js and .ts in one list sorted by name", async () => {
    const mixedDir = path.join(testDir, "mixed");
    mkdirSync(mixedDir, { recursive: true });
    writeFileSync(path.join(mixedDir, "1_first.js"), "");
    writeFileSync(path.join(mixedDir, "2_second.ts"), "");
    writeFileSync(path.join(mixedDir, "3_third.js"), "");
    writeFileSync(path.join(mixedDir, "notes.txt"), "");

    const files = await listFiles(mixedDir);
    expect(files).toEqual(["3_third.js", "2_second.ts", "1_first.js"]);
  });

  it("ignores TypeScript declaration files (.d.ts)", async () => {
    const declDir = path.join(testDir, "declarations");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(path.join(declDir, "1_real.ts"), "");
    writeFileSync(path.join(declDir, "2_real.up.sql"), "");
    writeFileSync(path.join(declDir, "3_real.js"), "");
    writeFileSync(path.join(declDir, "types.d.ts"), "");
    writeFileSync(path.join(declDir, "env.d.ts"), "");

    const files = await listFiles(declDir);
    expect(files).toEqual(["3_real.js", "2_real.up.sql", "1_real.ts"]);
    expect(files).not.toContain("types.d.ts");
    expect(files).not.toContain("env.d.ts");
  });

  it("ignores helper files starting with underscore (_)", async () => {
    const helperDir = path.join(testDir, "underscore-helpers");
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(path.join(helperDir, "1_real.ts"), "");
    writeFileSync(path.join(helperDir, "2_real.up.sql"), "");
    writeFileSync(path.join(helperDir, "3_real.js"), "");
    writeFileSync(path.join(helperDir, "_helpers.ts"), "");
    writeFileSync(path.join(helperDir, "_utils.js"), "");
    writeFileSync(path.join(helperDir, "_shared.up.sql"), "");

    const files = await listFiles(helperDir);
    expect(files).toEqual(["3_real.js", "2_real.up.sql", "1_real.ts"]);
  });

  it("returns an empty array for an empty directory", async () => {
    const emptyDir = path.join(testDir, "empty");
    mkdirSync(emptyDir, { recursive: true });

    const files = await listFiles(emptyDir);
    expect(files).toHaveLength(0);
  });
});

describe("resolveListDir()", () => {
  it("prefers the explicit override", () => {
    expect(resolveListDir("/custom/dir")).toBe("/custom/dir");
  });

  it("always returns an absolute path", () => {
    expect(path.isAbsolute(resolveListDir())).toBe(true);
    expect(path.isAbsolute(resolveListDir("migrations"))).toBe(true);
    expect(path.isAbsolute(resolveListDir("/custom/dir"))).toBe(true);
  });

  it("resolves a relative override against the process cwd", () => {
    expect(resolveListDir("migrations")).toBe(path.join(process.cwd(), "migrations"));
    expect(resolveListDir("./list/custom")).toBe(path.join(process.cwd(), "list", "custom"));
  });

  it("honors MIGRATION_LIST_DIR", () => {
    const previous = process.env["MIGRATION_LIST_DIR"];
    process.env["MIGRATION_LIST_DIR"] = path.join(testDir, "custom-list");
    try {
      expect(resolveListDir()).toBe(path.join(testDir, "custom-list"));
    } finally {
      if (previous === undefined) {
        delete process.env["MIGRATION_LIST_DIR"];
      } else {
        process.env["MIGRATION_LIST_DIR"] = previous;
      }
    }
  });

  it("resolves a relative MIGRATION_LIST_DIR against the process cwd", () => {
    const previous = process.env["MIGRATION_LIST_DIR"];
    process.env["MIGRATION_LIST_DIR"] = "list/custom";
    try {
      expect(resolveListDir()).toBe(path.join(process.cwd(), "list", "custom"));
    } finally {
      if (previous === undefined) {
        delete process.env["MIGRATION_LIST_DIR"];
      } else {
        process.env["MIGRATION_LIST_DIR"] = previous;
      }
    }
  });

  it("falls back to <cwd>/migrations", () => {
    const previous = process.env["MIGRATION_LIST_DIR"];
    delete process.env["MIGRATION_LIST_DIR"];
    try {
      expect(resolveListDir()).toBe(path.join(process.cwd(), DEFAULT_MIGRATIONS_DIR));
    } finally {
      if (previous !== undefined) {
        process.env["MIGRATION_LIST_DIR"] = previous;
      }
    }
  });
});

describe("checksumFile()", () => {
  it("hashes LF, CRLF, lone-CR and BOM variants of one content identically", async () => {
    const variantDir = path.join(testDir, "checksum-variants");
    mkdirSync(variantDir, { recursive: true });
    const content = "const up = async (tx) => {\n  await tx`SELECT 1`;\n};\n";
    writeFileSync(path.join(variantDir, "9_lf.js"), content);
    writeFileSync(path.join(variantDir, "8_crlf.js"), content.replaceAll("\n", "\r\n"));
    writeFileSync(path.join(variantDir, "7_cr.js"), content.replaceAll("\n", "\r"));
    writeFileSync(path.join(variantDir, "6_bom.js"), `\uFEFF${content}`);
    writeFileSync(
      path.join(variantDir, "5_bom_crlf.js"),
      `\uFEFF${content.replaceAll("\n", "\r\n")}`,
    );

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const expected = hasher.digest("hex");

    expect(await checksumFile(path.join(variantDir, "9_lf.js"))).toBe(expected);
    expect(await checksumFile(path.join(variantDir, "8_crlf.js"))).toBe(expected);
    expect(await checksumFile(path.join(variantDir, "7_cr.js"))).toBe(expected);
    expect(await checksumFile(path.join(variantDir, "6_bom.js"))).toBe(expected);
    expect(await checksumFile(path.join(variantDir, "5_bom_crlf.js"))).toBe(expected);
  });

  it("still hashes different content differently", async () => {
    const diffDir = path.join(testDir, "checksum-diff");
    mkdirSync(diffDir, { recursive: true });
    writeFileSync(path.join(diffDir, "9_left.js"), "const up = async (tx) => {};\n");
    writeFileSync(path.join(diffDir, "8_right.js"), "const up = async (tx) => { /* edited */ };\n");

    const left = await checksumFile(path.join(diffDir, "9_left.js"));
    const right = await checksumFile(path.join(diffDir, "8_right.js"));
    expect(left).not.toBe(right);
  });
});

describe("checksum normalization across line endings", () => {
  const FILE = "9_normalized.js";
  const BODY_TABLE = "normalized_table";

  function writeNormalizedMigration(listDir: string, lineEnding: string, withBom: boolean): string {
    const content = `const up = async (tx) => {
  await tx\`CREATE TABLE ${BODY_TABLE} (id INTEGER)\`;
};
const down = async (tx) => {};
export { up, down };
`;
    const filePath = path.join(listDir, FILE);
    writeFileSync(filePath, `${withBom ? "\uFEFF" : ""}${content.replaceAll("\n", lineEnding)}`);
    return filePath;
  }

  async function recordRawChecksum(
    options: { databaseUrl: string },
    filePath: string,
  ): Promise<void> {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(readFileSync(filePath));
    await installMigrations(options);
    const driver = await createDriver(options.databaseUrl);
    try {
      await driver.record(FILE, hasher.digest("hex"));
    } finally {
      await driver.close();
    }
  }

  it("re-checks a CRLF-recorded migration as LF without checksum drift", async () => {
    const scenario = makeScenario("bunsql-checksum-", "checksum.db");
    try {
      const filePath = writeNormalizedMigration(scenario.listDir, "\r\n", false);
      await migrateUp(scenario.options);

      const status = await migrateStatus(scenario.options);
      expect(status.applied[0]?.checksum).toBe(await checksumFile(filePath));

      writeNormalizedMigration(scenario.listDir, "\n", false);
      const result = await migrateUp(scenario.options);
      expect(result.applied).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("re-checks a BOM-recorded migration without BOM without checksum drift", async () => {
    const scenario = makeScenario("bunsql-checksum-", "checksum.db");
    try {
      writeNormalizedMigration(scenario.listDir, "\n", true);
      await migrateUp(scenario.options);

      writeNormalizedMigration(scenario.listDir, "\n", false);
      const result = await migrateUp(scenario.options);
      expect(result.applied).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("accepts a pre-normalization raw checksum and re-saves it normalized", async () => {
    const scenario = makeScenario("bunsql-checksum-", "checksum.db");
    try {
      const filePath = writeNormalizedMigration(scenario.listDir, "\r\n", false);
      await recordRawChecksum(scenario.options, filePath);

      const result = await migrateUp(scenario.options);
      expect(result.applied).toEqual([]);
      expect(readChecksums(scenario.dbPath)[FILE]).toBe(await checksumFile(filePath));
      expect(readTables(scenario.dbPath)).not.toContain(BODY_TABLE);
    } finally {
      scenario.cleanup();
    }
  });

  it("accepts a pre-normalization CRLF checksum when the file is now LF", async () => {
    const scenario = makeScenario("bunsql-checksum-", "checksum.db");
    try {
      writeNormalizedMigration(scenario.listDir, "\r\n", false);
      await recordRawChecksum(scenario.options, path.join(scenario.listDir, FILE));
      const filePath = writeNormalizedMigration(scenario.listDir, "\n", false);

      const result = await migrateUp(scenario.options);
      expect(result.applied).toEqual([]);
      expect(readChecksums(scenario.dbPath)[FILE]).toBe(await checksumFile(filePath));
      expect(readTables(scenario.dbPath)).not.toContain(BODY_TABLE);
    } finally {
      scenario.cleanup();
    }
  });

  it("dry-run accepts a pre-normalization checksum without re-saving it", async () => {
    const scenario = makeScenario("bunsql-checksum-", "checksum.db");
    try {
      const filePath = writeNormalizedMigration(scenario.listDir, "\r\n", false);
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(readFileSync(filePath));
      const rawChecksum = hasher.digest("hex");
      await recordRawChecksum(scenario.options, filePath);

      const result = await migrateUp({ ...scenario.options, dryRun: true });
      expect(result.planned).toEqual([]);
      expect(readChecksums(scenario.dbPath)[FILE]).toBe(rawChecksum);

      await migrateUp(scenario.options);
      expect(readChecksums(scenario.dbPath)[FILE]).toBe(await checksumFile(filePath));
    } finally {
      scenario.cleanup();
    }
  });

  it("still reports drift when the recorded checksum matches no variant", async () => {
    const scenario = makeScenario("bunsql-checksum-", "checksum.db");
    try {
      writeNormalizedMigration(scenario.listDir, "\n", false);
      await installMigrations(scenario.options);
      const driver = await createDriver(scenario.options.databaseUrl);
      try {
        await driver.record(FILE, "a".repeat(64));
      } finally {
        await driver.close();
      }

      await expect(migrateUp(scenario.options)).rejects.toThrow(ChecksumDriftError);
    } finally {
      scenario.cleanup();
    }
  });
});

describe("listFiles() symlinks", () => {
  it("follows symlinks to migration files", async () => {
    const linkDir = path.join(testDir, "symlinks");
    mkdirSync(linkDir, { recursive: true });
    writeFileSync(path.join(testDir, "shared_migration_body.js"), "");

    symlinkSync(path.join(testDir, "shared_migration_body.js"), path.join(linkDir, "1_link.js"));
    symlinkSync(
      path.join(testDir, "shared_migration_body.js"),
      path.join(linkDir, "2_link.up.sql"),
    );

    const files = await listFiles(linkDir);
    expect(files).toEqual(["2_link.up.sql", "1_link.js"]);
  });

  it("ignores broken symlinks instead of failing the listing", async () => {
    const brokenDir = path.join(testDir, "symlinks-broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "1_real.js"), "");
    symlinkSync(path.join(brokenDir, "missing_target.js"), path.join(brokenDir, "2_broken.js"));

    const files = await listFiles(brokenDir);
    expect(files).toEqual(["1_real.js"]);
  });

  it("does not list a symlink pointing at a directory", async () => {
    const dirLinkParent = path.join(testDir, "symlinks-dir");
    const targetDir = path.join(dirLinkParent, "nested");
    mkdirSync(targetDir, { recursive: true });
    symlinkSync(targetDir, path.join(dirLinkParent, "1_dir.js"));

    const files = await listFiles(dirLinkParent);
    expect(files).toEqual([]);
  });

  it("applies a migrations directory built entirely from symlinks", async () => {
    const scenario = makeScenario("bunsql-symlink-", "symlink.db");
    const sharedDir = path.join(scenario.dir, "shared");
    try {
      mkdirSync(sharedDir, { recursive: true });
      for (const [file, table] of [
        ["1_shared.js", "symlink_table_one"],
        ["2_shared.js", "symlink_table_two"],
      ] as const) {
        writeFileSync(
          path.join(sharedDir, file),
          `const up = async (tx) => {
  await tx\`CREATE TABLE ${table} (id INTEGER)\`;
};
const down = async (tx) => {};
export { up, down };
`,
        );
        symlinkSync(path.join(sharedDir, file), path.join(scenario.listDir, file));
      }

      const result = await migrateUp(scenario.options);
      expect(result.applied).toEqual(["2_shared.js", "1_shared.js"]);

      const status = await migrateStatus(scenario.options);
      expect(status.pending).toEqual([]);
      expect(readTables(scenario.dbPath)).toContain("symlink_table_two");
    } finally {
      scenario.cleanup();
    }
  });
});
