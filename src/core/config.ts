import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type MigrationLang } from "../api/create.js";

export interface ProjectConfig {
  databaseUrl?: string;
  listDir?: string;
  tableName?: string;
  schema?: string;
  lang?: MigrationLang;
  lockTimeout?: number;
  waitTimeout?: number;
}

const CONFIG_FILE_NAMES = ["bunsql-migrate.config.ts", "bunsql-migrate.config.js"];

type ConfigKeyType = "string" | "lang" | "seconds";

const CONFIG_KEYS: Record<string, ConfigKeyType> = {
  databaseUrl: "string",
  listDir: "string",
  tableName: "string",
  schema: "string",
  lang: "lang",
  lockTimeout: "seconds",
  waitTimeout: "seconds",
};

export class InvalidConfigError extends Error {
  readonly configPath: string;

  constructor(configPath: string, detail: string) {
    super(`${configPath}: ${detail}`);
    this.name = "InvalidConfigError";
    this.configPath = configPath;
  }
}

function resolveConfigPath(override?: string): string | null {
  if (override !== undefined) {
    const resolved = path.resolve(override);
    if (!existsSync(resolved)) {
      throw new InvalidConfigError(override, "config file not found");
    }
    return resolved;
  }
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.resolve(name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function importConfig(filePath: string): Promise<Record<string, unknown>> {
  let moduleNamespace: Record<string, unknown>;
  try {
    moduleNamespace = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new InvalidConfigError(
      filePath,
      `could not load the config file — ${errorMessage(error)}`,
    );
  }
  const exported =
    moduleNamespace["default"] !== undefined ? moduleNamespace["default"] : moduleNamespace;
  if (typeof exported !== "object" || exported === null || Array.isArray(exported)) {
    throw new InvalidConfigError(filePath, "must export a config object");
  }
  return exported as Record<string, unknown>;
}

function quoteKeys(keys: string[]): string {
  return keys.map((key) => `"${key}"`).join(", ");
}

function validateConfig(filePath: string, raw: Record<string, unknown>): ProjectConfig {
  const unknownKeys = Object.keys(raw).filter((key) => !(key in CONFIG_KEYS));
  if (unknownKeys.length > 0) {
    const label = unknownKeys.length > 1 ? "unknown config keys" : "unknown config key";
    throw new InvalidConfigError(filePath, `${label} ${quoteKeys(unknownKeys)}`);
  }

  const problems: string[] = [];
  const config: Record<string, string | number> = {};
  for (const [key, kind] of Object.entries(CONFIG_KEYS)) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (kind === "string") {
      if (typeof value === "string") {
        config[key] = value;
      } else {
        problems.push(`expected a string for "${key}"`);
      }
      continue;
    }
    if (kind === "lang") {
      if (value === "js" || value === "ts") {
        config[key] = value;
      } else {
        problems.push(`expected "js" or "ts" for "${key}"`);
      }
      continue;
    }
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      config[key] = value;
    } else {
      problems.push(`expected a non-negative integer for "${key}"`);
    }
  }
  if (problems.length > 0) {
    throw new InvalidConfigError(filePath, problems.join("; "));
  }
  return config as ProjectConfig;
}

export async function loadProjectConfig(configPath?: string): Promise<ProjectConfig> {
  const filePath = resolveConfigPath(configPath);
  if (filePath === null) {
    return {};
  }
  return validateConfig(filePath, await importConfig(filePath));
}
