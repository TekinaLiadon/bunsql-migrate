# bunsql-native-migrate

[![CI](https://github.com/TekinaLiadon/bunsql-migrate/actions/workflows/ci.yml/badge.svg)](https://github.com/TekinaLiadon/bunsql-migrate/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/bunsql-native-migrate.svg)](https://www.npmjs.com/package/bunsql-native-migrate)

Zero-ORM SQL file migrations for [Bun](https://bun.sh): PostgreSQL, MySQL/MariaDB and SQLite through the built-in `Bun.SQL` client.

No ORM, no schema diffing, no lock-in — you write plain `.js`/`.ts` migration files with `up()`/`down()` exports (optionally `up(tx)`/`down(tx)` for transactional migrations, see below), or pure SQL pairs (`name.up.sql` / `name.down.sql`) for migrations with no JS logic — and run them with a tiny CLI or the programmatic API.

## Features

- **Bun-native** — built on the unified [`Bun.SQL`](https://bun.com/docs/runtime/sql) client (PostgreSQL, MySQL/MariaDB, SQLite). No Node.js support.
- **Zero ORM** — migrations are plain JavaScript, TypeScript or SQL files; use `sql` tagged templates or any Bun database client you like.
- **Zero dependencies**.
- **Checksums** — every applied migration is checksummed (SHA-256). A modified applied file fails the run instead of silently drifting.
- **Concurrent-safe `up`** — an advisory database lock serializes racing `up` runs (two deploy pods, CI + laptop) so a migration body never executes twice.
- **Dev loop `redo`** — `down` + `up` of the last migrations in one command: re-run a migration you are still editing without checksum-drift noise.
- **Wait for the database** — `--wait <seconds>` polls the connection before running, so a CI step next to a starting container needs no `sleep`/wait-for-it hacks.
- **Non-transactional migrations** — a `noTransaction` marker (or a header directive in a `.sql` file) runs a migration outside the transaction wrapper, for operations like `CREATE INDEX CONCURRENTLY`.
- **Legacy backfill** — records without a checksum are backfilled automatically on the next `up`.
- **Dry run** — `up --dry-run` / `down --dry-run` print the plan without touching the database.
- **Custom tracking table** — several projects can share one database, each with its own history table (`--table`, and `--schema` for PostgreSQL).
- **CLI and library** — use it as `bunx bunsql-native-migrate` or import the functions directly.

## Installation

```bash
bun add bunsql-native-migrate
```

Requires Bun ≥ 1.4.2 — the version this package is developed and tested against. (The unified `Bun.SQL` client it is built on exists since Bun 1.2.21, when MySQL/MariaDB and SQLite support were added.)

## Supported database versions

| Engine     | Tested versions   | Notes                                                                                                                                            |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL | 14, 16, 17        | Wired through the full `Bun.SQL` PostgreSQL backend.                                                                                             |
| MySQL      | 8.0, 8.4 (LTS)    | `caching_sha2_password` over plain TCP requires TLS or public-key retrieval — see the note in [Drivers](#drivers) for the native-password setup. |
| MariaDB    | 10.11 (LTS), 11.x |                                                                                                                                                  |
| SQLite     | follows Bun       | The engine is the SQLite bundled with your Bun runtime (`bun:sqlite`); there is no separate server to version.                                   |

CI runs one version per engine on every push (PostgreSQL 14 + MariaDB 11); the full matrix above is exercised before every release — locally through the repo's `compose.yaml` profiles (`docker compose up -d pg14 mariadb11 …`) and `bun run test:matrix`, or via the manual "CI" workflow dispatch on GitHub Actions.

## Quick start

```bash
# scaffold the migrations directory with your first migration stub
# (prints the next steps: set DATABASE_URL, then run up)
bunx bunsql-native-migrate init

# add more migrations as you go
bunx bunsql-native-migrate create add_users_table

# create the tracking table (optional — up() does it automatically)
bunx bunsql-native-migrate install

# apply pending migrations
bunx bunsql-native-migrate up

# see what is applied and what is pending
bunx bunsql-native-migrate status

# CI gate: same listing, but exit code 2 while migrations are pending
bunx bunsql-native-migrate status --strict

# roll back the last applied migration
bunx bunsql-native-migrate down

# dev loop: roll back the last migration and re-apply it in one command
# (also: redo 3, redo --to 2_add_users.ts — see Redo below)
bunx bunsql-native-migrate redo
```

The CLI reads `DATABASE_URL` from the environment (or a `.env` file — Bun loads it automatically). Pass `--url <url>` to point a single run at another database; the flag wins when both are set. Any of these can also live in a [configuration file](#configuration-file) in the project root.

### Migration file format

```js
import { sql } from "bun";

const up = async () => {
  await sql`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)`;
};

const down = async () => {
  await sql`DROP TABLE users`;
};

export { up, down };
```

Files live in the migrations directory (default `./migrations`, override with `--dir` or the `MIGRATION_LIST_DIR` env var) and are applied in descending filename order. Any file ending in `.js`, `.ts` or `.up.sql` is a migration (TypeScript declaration files — `*.d.ts` — are ignored, so a `types.d.ts` next to the migrations never shows up as pending), `.js` and `.ts` both work — Bun runs TypeScript natively — and the order is decided purely by the filename, never by the extension. `bunsql-native-migrate create` generates TypeScript stubs by default (`--lang js` for JavaScript) with an inverted timestamp prefix so newer migrations sort first:

```
9999999999999_2026_09_13_add_users_table.ts
```

### SQL migration pairs

Migrations without JS logic can be plain SQL files. The format is a pair named after the migration:

```
migrations/
  9999999999998_2026_09_14_add_index.up.sql
  9999999999998_2026_09_14_add_index.down.sql
```

- The `.up.sql` file **is** the migration: its full filename is what gets recorded, shown in `status` and used as the `--to` target (`...add_index.up.sql`).
- The `.down.sql` pair is the rollback. A migration without one reverts like a `.js` file without a `down()` export: the tracking record is removed with a warning and nothing is executed.
- Pairs sort together with `.js`/`.ts` files strictly by filename, so all three kinds interleave in one history.
- Both files may contain several statements separated by semicolons — the whole file is sent as one batch.
- A `.sql` migration runs inside a transaction on the runner's connection: on PostgreSQL and SQLite a failing statement rolls back the whole file and nothing is recorded; on MySQL/MariaDB DDL implicitly commits, so there only DML gets rollback protection (the same caveat as transactional JS migrations). A file whose leading comment block carries the `-- bunsql-migrate:no-transaction` directive runs outside the transaction instead — see [Non-transactional migrations](#non-transactional-migrations-notransaction).
- The checksum covers the `.up.sql` file; editing a `.down.sql` after the fact is not tracked, exactly like JS `down()` bodies.

### Transactional migrations

Declare a `tx` parameter on `up`/`down` and the migration runs inside a single database transaction: if any statement fails, the partial work is rolled back instead of being left half-applied, and nothing is recorded.

```js
const up = async (tx) => {
  await tx`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)`;
  await tx`INSERT INTO users (id, name) VALUES (1, 'admin')`;
};

const down = async (tx) => {
  await tx`DROP TABLE users`;
};

export { up, down };
```

- `bunsql-native-migrate create` generates stubs in this form by default (as TypeScript, with `tx` typed as a Bun `SQL` client bound to the same database the runner is connected to).
- Migrations declared **without** parameters keep using the global `sql` client and run without a transaction — both styles can coexist in one project, decided per migration by the declared signature.
- The mode is decided by the **number of declared parameters** (`function.length`). A parameter with a default value or a rest parameter (`async (tx = sql) => …`, `async (...args) => …`) is counted as zero parameters and would silently run outside the transaction, so such a migration is rejected with a clear error at load time — declare `tx` without a default, or export `noTransaction = true` if you really want the non-transactional path.
- Engine caveats: PostgreSQL and SQLite roll back everything, DDL included. On MySQL/MariaDB any DDL statement implicitly commits the current transaction, so there only DML gets rollback protection.
- The tracking record is written right after the transaction commits. A crash in that single-statement window leaves the migration applied but unrecorded — the next `up` would re-run it, so keep critical migrations idempotent (this window exists for plain `up()` migrations too, just wider).

### Non-transactional migrations

Some operations cannot run inside a transaction — most notably `CREATE INDEX CONCURRENTLY` on PostgreSQL. Export `noTransaction` from the migration file and both `up` and `down` run outside the transaction wrapper, with the runner's own database client passed where the `tx` client normally goes:

```js
const up = async (db) => {
  await db`CREATE INDEX CONCURRENTLY users_email_idx ON users (email)`;
};

const down = async (db) => {
  await db`DROP INDEX CONCURRENTLY users_email_idx`;
};

const noTransaction = true;
export { up, down, noTransaction };
```

- **There is no automatic rollback.** A failing statement leaves whatever ran before it applied, and nothing is recorded — write such migrations accordingly: one statement per migration, idempotent bodies, or manual cleanup in `down`.
- The client you receive is the driver's live connection, not a transaction. On pooled engines (PostgreSQL, MySQL/MariaDB) consecutive statements of one migration may run on different pooled connections — keep that in mind for anything session-scoped.
- On MySQL/MariaDB the marker changes little (DDL already implicitly commits) but it also gives up the DML rollback protection there.
- For SQL pairs the equivalent is a directive in the leading comment block of the file:

```sql
-- bunsql-migrate:no-transaction
CREATE INDEX CONCURRENTLY users_email_idx ON users (email);
```

The directive is honored only before the first statement; each file of the pair is marked separately, so a concurrently-built index needs the directive on its `.down.sql` too (`DROP INDEX CONCURRENTLY` cannot run in a transaction either).

### Migrations directory path resolution

Relative paths — whether from `--dir`, the `listDir` option or `MIGRATION_LIST_DIR` — are always resolved against the **current working directory** of the process (the same anchor Bun uses to load `.env`). Run the CLI from your project root and plain `./migrations` works as expected.

Absolute paths are passed through unchanged, which is the safe choice for CI/CD and other automation where the working directory is not guaranteed to be the repository root:

```bash
DATABASE_URL=$SECRET_URL bunx bunsql-native-migrate up --dir "$CI_WORKSPACE/migrations"
```

This resolution is part of the library contract: `resolveListDir` (and therefore every API function) always returns a fully qualified absolute path, so programmatic callers can pass either form and get identical behavior from any working directory.

### Configuration file

Typing `--dir`, `--table`, `--schema` and `--url` on every command gets old fast, and a typo there can point a run at the wrong database. A config file in the project root holds the defaults once:

```ts
// bunsql-migrate.config.ts
export default {
  databaseUrl: "postgres://user:pass@localhost:5432/app",
  listDir: "./migrations",
  tableName: "app_migrations",
  schema: "private",
  lang: "ts",
  lockTimeout: 60,
  waitTimeout: 10,
};
```

The keys mirror the programmatic options; named exports (`export const tableName = …`) work too. Resolution order for every key:

1. the CLI flag (`--table …`),
2. the config file,
3. the env var / built-in default (`DATABASE_URL`, `MIGRATION_LIST_DIR`, table `migrations`, lock timeout `30`, …).

Notes:

- The CLI looks for `bunsql-migrate.config.ts`, then `bunsql-migrate.config.js` in the working directory. `--config <path>` loads a file elsewhere (a relative path resolves against the cwd) — it is the only flag that can point at a file that is not in the project root.
- No config file is not an error — the built-in defaults apply as before.
- A config file that cannot be parsed, exports a non-object, holds an unknown key or a value of the wrong type fails the run with `InvalidConfigError` before any database connection is made (exit 5, see [Exit codes](#exit-codes)).
- `tableName`/`schema` from the config go through the same identifier validation as the flags, so a hostile name there never reaches the database either.
- The config file is a normal TypeScript module: `import` secrets from env or compute paths, but keep it out of version control when it holds credentials.

Programmatic callers can load the same file with the exported `loadProjectConfig(path?)` (returns an empty object when no file is found; throws `InvalidConfigError` on a broken file) and merge it into their option objects.

## CLI reference

```
bunsql-native-migrate <init|up|down [n]|redo [n]|install|create [name]|mark [name]|status|version> [--url <url>] [--dir <migrations-dir>] [--config <path>] [--to <name>] [--lock-timeout <seconds>] [--wait <seconds>] [--table <name>] [--schema <name>] [--dry-run] [--all] [--lang <js|ts>] [--git] [--strict] [--version] [--help]
```

| Command         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| `init`          | Onboarding: creates the migrations directory (honoring `--dir`) with the first stub migration `..._initial.ts` and prints the next steps (set `DATABASE_URL`, run `up`). Idempotent: when the directory already contains migrations it prints a note and creates nothing.                                                                                                                                                                                                                                          |
| `up`            | Applies pending migrations (creating the tracking table if needed); each applied file prints `<file> migrated up (<duration>)`, e.g. `2_add_users.ts migrated up (120ms)` (seconds with one decimal once past a second). Prints `No pending migrations.` when there is nothing to apply. `up --to <name>` applies pending migrations in order up to and including the named one.                                                                                                                                   |
| `down`          | Reverts the last applied migration; `down <n>` reverts the last `n`, `down --all` reverts everything, `down --to <name>` reverts everything from the latest back to the named migration **inclusive** (the target becomes pending, exactly the mirror of `up --to`) — always most-recent-first, each printing `<file> rolled back (<duration>)`. An unknown name is an error before any writes (exit 1); a target that is not applied is a reported no-op. Prints `No migrations to rollback.` when there is none. |
| `redo [n]`      | The edit-rerun dev loop: reverts the last applied migration (or the last `n`, or everything down to `--to <name>` inclusive) and immediately re-applies it. Prints `No migrations to redo.` on a fresh database (exit 0); an unapplied `--to` target is a reported no-op. See [Redo](#redo-re-running-migrations-you-are-still-editing).                                                                                                                                                                           |
| `install`       | Creates the tracking table only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `create [name]` | Creates a stub migration file from the template — TypeScript by default, `--lang js` for JavaScript; without a `name` a random `adjective_noun` is generated. The name may only contain letters, digits, hyphens and underscores — anything else (a path separator, `..`, a space) is rejected with exit 5 before anything is created.                                                                                                                                                                             |     |
| `mark [name]`   | Baseline for an existing database: writes tracking records **without running anything**. `mark <name>` marks every pending migration up to and including the named one; `mark --all` marks all of them. Records carry the actual file checksums, so the next `up` treats them as applied (see [Baseline](#baseline-adopting-an-existing-database-mark)).                                                                                                                                                           |
| `status`        | Lists applied and pending migrations (no changes to the database except creating the tracking table if missing) and prints an `N applied, M pending` summary.                                                                                                                                                                                                                                                                                                                                                      |
| `version`       | Prints the package version (from its own `package.json`, not yours) and exits 0 — no `DATABASE_URL` needed, no connection opened. The `--version` flag does the same from any invocation and wins over the command.                                                                                                                                                                                                                                                                                                |

| Flag                     | Applies to                           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--url <url>`            | up/down/redo/install/mark/status     | Connection string for this run. Takes priority over the `DATABASE_URL` env var when both are set. Handy for engine matrices and CI without mutating `process.env`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `--dir <migrations-dir>` | up/down/redo/init/create/mark/status | Migrations directory (default `./migrations`, or the `MIGRATION_LIST_DIR` env var). Not accepted by `install` — it never reads the migrations directory.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--config <path>`        | all                                  | Load project defaults from this file instead of auto-detecting `bunsql-migrate.config.ts` (see [Configuration file](#configuration-file)).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--to <name>`            | `up`, `down`, `redo`                 | `up`: apply pending migrations up to and including the named file. An unknown name is an error (exit 1); a target that is already applied is a no-op. `down`: revert everything from the latest back to the named migration inclusive (the target must be applied; an unknown name is an error before any writes, a pending target is a no-op; cannot be combined with a step count or `--all`). `redo`: revert everything down to the named migration inclusive, then re-apply it (the target must be applied; unknown name is an error before any writes). |
| `--lock-timeout <sec>`   | `up`, `redo`                         | How long to wait for the migration lock when another `up` is running, in seconds (default `30`, `0` fails immediately). On timeout: exit 4. Applies to redo's `up` phase; `down` also takes the lock, always with the default timeout.                                                                                                                                                                                                                                                                                                                       |
| `--wait <sec>`           | up/down/redo/install/mark/status     | Wait for the database to become ready: poll the connection up to N seconds before running the command. Default (or `0`) is a single attempt, the previous behavior. Config mistakes — an unparseable URL, an invalid `--table` — still fail immediately; a wait that times out exits 1 with `database was not ready within Ns` (see [Exit codes](#exit-codes)).                                                                                                                                                                                              |
| `--table <name>`         | up/down/redo/install/mark/status     | Track history in this table instead of `migrations` (see [Custom tracking table](#custom-tracking-table)).                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--schema <name>`        | up/down/redo/install/mark/status     | PostgreSQL only: create/read the tracking table in this schema (must already exist). Rejected with an error on MySQL and SQLite.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--dry-run`              | `up`, `down`                         | Print what a real run would apply or revert and exit — no migration bodies run, nothing is recorded, the tracking table is not even created (see [Dry run](#dry-run)).                                                                                                                                                                                                                                                                                                                                                                                       |
| `--all`                  | `down`, `mark`                       | `down`: revert every applied migration (most-recent-first); cannot be combined with a step count. `mark`: mark every pending migration as applied; cannot be combined with a file name.                                                                                                                                                                                                                                                                                                                                                                      |
| `--git`                  | `create`                             | `git add` the created file. When staging fails, the CLI prints an error and exits 1 — the file itself stays on disk.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--lang <js\|ts>`        | `create`, `init`                     | Language of the created stub. Default: `ts`. An unknown or missing value is an error (exit 5).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--strict`               | `status`                             | Exit with code 2 when migrations are pending — a gate for CI/CD pipelines. Exit 0 otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--version`              | —                                    | Print the package version and exit 0 (same as the `version` command; works without `DATABASE_URL`).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--help`, `-h`           | —                                    | Prints the usage line and exits with code 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Flags are validated per command following the "Applies to" column: passing a flag the command does not take (`redo --all`, `redo --dry-run`, `mark --to …`, `install --dir …`) is a usage error — the CLI prints `redo does not support --all`, shows the usage line and exits 5 before touching the database. Flags with a value (`--url`, `--dir`, `--config`, `--to`, `--table`, `--schema`) require one: a missing, empty or flag-like value (`down --dir --dry-run 2`) is a usage error too, so a value can never silently swallow the next flag or fall back to defaults. Only `--help` and `--version` are global (either wins over any command); `--config` is accepted by every command as well, but the `version` command ignores it entirely (it must work outside a project). Positional arguments are command-specific too: `up`, `install`, `status`, `init` and `version` take none, and an empty positional is a usage error.

### Exit codes

The CLI distinguishes error categories so a CI/CD pipeline can react to each one:

| Code | Meaning                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success.                                                                                                                                            |
| `1`  | Any other failure: connection errors, a failing migration, an unknown `--to` target, an applied migration file missing from disk, a wait timeout, … |
| `2`  | `status --strict` with pending migrations (the CI gate).                                                                                            |
| `3`  | Checksum drift — an applied file was modified after it was applied.                                                                                 |
| `4`  | Migration lock timeout — another `up` held the lock past `--lock-timeout`.                                                                          |
| `5`  | Usage error or an invalid configuration/identifier, reported before any connection is made.                                                         |

Any failure (connection errors, a failing migration, a modified applied file) is printed and the CLI exits with a category-specific code — see [Exit codes](#exit-codes) above.

Example `up` output:

```
2_add_index.up.sql migrated up (120ms)
1_add_users.ts migrated up (1.4s)
Applied 2 migration(s).
```

## Programmatic API

```ts
import {
  migrateUp,
  migrateDown,
  migrateRedo,
  migrateStatus,
  installMigrations,
  createMigration,
  markMigrationsApplied,
  createDriver,
  loadProjectConfig,
  ChecksumDriftError,
  DatabaseWaitTimeoutError,
  InvalidConfigError,
  InvalidIdentifierError,
  MigrationLockError,
  MigrationNotFoundError,
  GitStageError,
} from "bunsql-native-migrate";

const { applied } = await migrateUp({
  databaseUrl: "postgres://user:pass@localhost:5432/app", // default: DATABASE_URL env
  listDir: "./migrations", // default: MIGRATION_LIST_DIR env or ./migrations
  to: "2_add_columns.ts", // optional: apply up to and including this file
  lockTimeout: 60, // optional: seconds to wait for the migration lock (default 30, 0 = fail fast)
  waitTimeout: 30, // optional: seconds to wait for the database to become ready (default 0 = single attempt)
  tableName: "app_migrations", // optional: custom tracking table (default "migrations")
  schema: "private", // optional: postgres schema for the tracking table
});

const { reverted } = await migrateDown(); // reverted: string[] (most-recent-first)
await migrateDown({ steps: 3 }); // revert the last three
await migrateDown({ steps: "all" }); // revert everything
await migrateDown({ to: "2_add_columns.ts" }); // revert down to this file inclusive

const redo = await migrateRedo(); // redo: { reverted, applied } — revert the last and re-apply
await migrateRedo({ steps: 3 }); // redo the last three
await migrateRedo({ to: "2_batch.ts" }); // redo everything down to 2_batch.ts inclusive

const { planned } = await migrateUp({ dryRun: true }); // preview only (see Dry run)
// planned: string[] — what a real up would apply, applied stays []
await migrateDown({ dryRun: true }); // planned: what down would revert, reverted stays []

const status = await migrateStatus();
// status.applied: ExecutedMigration[] (name + checksum, in apply order)
// status.pending: string[] (files waiting to be applied, in apply order)

const { marked } = await markMigrationsApplied({ to: "2_baseline.up.sql" });
// marked: string[] — files recorded as applied without running (see Baseline)
await markMigrationsApplied(); // mark every pending migration

await installMigrations(); // creates the tracking table

const filename = await createMigration({ name: "add_users_table", listDir: "./migrations" });

const config = await loadProjectConfig("./bunsql-migrate.config.ts");
// config: { databaseUrl?, listDir?, tableName?, schema?, lang?, lockTimeout?, waitTimeout? }
// — {} when the file is missing, throws InvalidConfigError when it is broken
```

All options are optional unless stated otherwise:

| Option        | Where                                                                                                    | Default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `databaseUrl` | `migrateUp`, `migrateDown`, `migrateRedo`, `migrateStatus`, `markMigrationsApplied`, `installMigrations` | `DATABASE_URL` env var                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `listDir`     | all functions                                                                                            | `MIGRATION_LIST_DIR` env var, then `./migrations` (relative paths resolve against the process cwd)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `waitTimeout` | `migrateUp`, `migrateDown`, `migrateRedo`, `migrateStatus`, `markMigrationsApplied`, `installMigrations` | `0` — a single connection attempt, the previous behavior. A positive value polls the connection for that many seconds before running (CLI `--wait`); on expiry it throws `DatabaseWaitTimeoutError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tableName`   | `migrateUp`, `migrateDown`, `migrateRedo`, `migrateStatus`, `markMigrationsApplied`, `installMigrations` | `"migrations"` — a custom tracking table name (see [Custom tracking table](#custom-tracking-table))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `schema`      | `migrateUp`, `migrateDown`, `migrateRedo`, `migrateStatus`, `markMigrationsApplied`, `installMigrations` | — PostgreSQL only: the schema holding the tracking table (must already exist); rejected on other URLs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `to`          | `migrateUp`, `migrateDown`, `markMigrationsApplied`, `migrateRedo`                                       | `migrateUp`: apply pending migrations in order up to and including the named file (unknown name throws `MigrationNotFoundError`, an already-applied target applies nothing). `migrateDown`: revert everything from the latest back to the named migration inclusive — the target must be applied (a pending target is a reported no-op), an unknown name throws `MigrationNotFoundError` before any writes, cannot be combined with `steps`. `markMigrationsApplied`: same boundary as `up`, but the files are only recorded as applied; omitted — mark every pending migration. `migrateRedo`: revert everything down to the named migration inclusive and re-apply it; the target must be applied, otherwise a reported no-op |
| `lockTimeout` | `migrateUp`, `migrateRedo`                                                                               | `30` — seconds to wait for the migration lock while another `up` is running; `0` fails immediately; a timeout throws `MigrationLockError`. Applies to redo's `up` phase                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `dryRun`      | `migrateUp`, `migrateDown`                                                                               | `false` — plan only: the result carries `planned: string[]` while `applied`/`reverted` stay empty (see [Dry run](#dry-run))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `steps`       | `migrateDown`, `migrateRedo`                                                                             | `1` — `migrateDown`: revert the last `n` applied migrations (`1`–`n` or `"all"`), most-recent-first; cannot be combined with `to`. `migrateRedo`: redo the last `n` (positive integer, no `"all"`); cannot be combined with `to`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `name`        | `createMigration`                                                                                        | random `adjective_noun` name; only letters, digits, hyphens and underscores are accepted — anything else throws `InvalidMigrationNameError` before a file is created                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lang`        | `createMigration`                                                                                        | `"ts"` — pass `"js"` for a JavaScript stub                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `git`         | `createMigration`                                                                                        | `false` — `git add` the new file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

`migrateDown` reverts strictly in reverse apply order and stops at the first failing rollback: migrations reverted before the failure stay reverted, the failing one keeps its tracking record, and the error propagates to the caller. An applied migration whose file is missing from the migrations directory stops the `down` the same way — it throws `MigrationFileMissingError` (`<file> is missing from the migrations directory — restore the file or remove its tracking record manually`) instead of the module loader's raw error; nothing about it is reverted or removed automatically. `to` and `steps` are two ways to pick the revert window — passing both is an error before anything runs.

### Drivers

The driver is picked from the URL protocol:

| Protocol                       | Client                    | Notes                                                                                                                       |
| ------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `postgres://`, `postgresql://` | `Bun.SQL` (PostgreSQL)    | Full-featured backend of `Bun.SQL`.                                                                                         |
| `mariadb://`, `mysql://`       | `Bun.SQL` (MySQL/MariaDB) | MySQL 8's `caching_sha2_password` over plain TCP requires TLS or `allowPublicKeyRetrieval: true` on the server config side. |
| `sqlite://`, `sqlite:`         | `Bun.SQL` (SQLite)        | Single connection, no pooling — fine for migrations.                                                                        |

All three adapters share the same `Bun.SQL` tagged-template API, so migration files (`import { sql } from "bun"`) work identically regardless of the database.

Known MySQL/MariaDB limitation of `Bun.SQL` (not used by this package, good to know for your own migrations): no `RETURNING` clause; use `result.lastInsertRowid` or a follow-up `SELECT` instead.

Bun's client also recognizes `mysql2://` and `file://` URLs — `createDriver` deliberately rejects them. Stick to the protocols listed above.

`createDriver(url)` returns a `MigrationDriver` (`install`/`listExecuted`/`record`/`setChecksum`/`remove`/`close`) if you need custom tracking logic; `listExecuted` yields `ExecutedMigration` records (`name`, `checksum`). It also accepts the same `{ tableName, schema }` options as the API functions. Custom drivers may also implement the optional `tryLock(timeoutSeconds)` / `releaseLock()` pair to participate in [concurrent-run locking](#concurrent-runs) — without them, `migrateUp` simply runs unlocked; `tryLock` is non-blocking by contract: it reports whether the lock is free right now and takes it if so, while the waiting (polling every 100 ms up to `lockTimeout`) is implemented by the caller — none of the built-in drivers blocks inside `tryLock`, and custom implementations should not either — the optional `trackingTableExists()` used by `up`'s [dry run](#dry-run) to plan against a database that has no tracking table yet, and the optional `trackingTableCurrent()` probe that lets `up`/`down`/`status`/`mark` skip re-running `install()` when the tracking table already has its checksum column and unique index — without the probe, those commands install the table up front as before.

### Tracking table

Applied migrations are recorded in a `migrations` table with a unique name and a SHA-256 checksum. The table lives in the database you connect to: two projects pointed at the same database share one history and one `down` stack — give each project its own database. `migrate:up` aborts when an applied file has been modified after the fact:

```
1_first.js was modified after it was applied — restore the file or resolve the drift manually
```

Records created before checksums existed (checksum `NULL`) are backfilled on the next `up`.

### Custom tracking table

Several projects can point at one database without sharing a history: give each its own tracking table with `tableName` (CLI `--table`), optionally in a PostgreSQL schema with `schema` (CLI `--schema`, the schema must already exist — it is not created for you). The unique index is derived from the table name (`<table>_migration_unique`), so custom tables never collide, and the legacy checksum backfill works in custom tables too. Two concurrent `up` runs still serialize on the same per-database lock even with different tables — they share the database, after all.

Names are validated before the driver connects: an identifier of letters, digits, underscores and dollar signs, starting with a letter or underscore (PostgreSQL ≤ 63 chars, MySQL/MariaDB ≤ 47, SQLite ≤ 128; schema ≤ 63). Anything else — spaces, quotes, semicolons — throws `InvalidIdentifierError` and the CLI exits 5, so a hostile name can never reach the database. The `schema` option on a MySQL or SQLite URL is an error as well: MySQL selects the database in the URL itself and SQLite has no schemas.

### Baseline: adopting an existing database (mark)

Adopting the tool on a database whose schema was created before it existed? `mark` writes the tracking records without running anything — the files are declared applied, so the next `up` skips them instead of re-creating what is already there:

```bash
# mark every pending migration up to and including 2_baseline.up.sql
bunx bunsql-native-migrate mark 2_baseline.up.sql

# mark every pending migration
bunx bunsql-native-migrate mark --all
```

- Records carry the actual file checksums, so a later `up` neither re-applies the marked files nor throws `ChecksumDriftError`; only migrations newer than the boundary are executed from then on.
- `up()`/`down()` are never called by `mark` — but a later `down` **will** run the `down()` bodies of marked migrations, so make sure they match the schema that actually exists before rolling anything back.
- An unknown name is an error before anything is written (exit 1, `MigrationNotFoundError`); a target that is already applied is a no-op.
- Re-running is safe: `record` deduplicates at the database level (unique name), so even racing `mark` runs converge on the same history.

### Dry run

`up --dry-run` and `down --dry-run` (API: `dryRun: true`) preview a run without changing anything:

```
Dry run — no changes will be made.
2_add_index.up.sql would be applied
1_add_users.ts would be applied
Would apply 2 migration(s).
```

- Nothing is executed and nothing is recorded — not even the tracking table is created, so it is safe against any database, production included. A database without the table simply plans everything as pending.
- The plan honors every option the real run would: `to`, `steps`, `--table`/`--schema`. The checksum drift check runs too — a dry run reports `ChecksumDriftError` exactly where the real run would fail (the legacy NULL-checksum backfill is the one write it skips).
- `down --dry-run` plans the revert list in reverse apply order; on an empty history — a database that has never seen an `up`, included — it prints `No migrations to rollback.` like the real command. A real `down` creates the tracking table when it is missing, so it degrades to the same message instead of a driver error.
- In the API result the plan lands in `planned: string[]` while `applied`/`reverted` stay empty — existing consumers keep working untouched.

### Redo: re-running migrations you are still editing

While a migration is still being shaped, the loop is _edit → down → up_. `redo` collapses it into one command (CLI `redo`, `redo <n>`, `redo --to <name>`; API `migrateRedo`):

```bash
bunx bunsql-native-migrate redo           # re-run the last applied migration
bunx bunsql-native-migrate redo 3         # re-run the last three
bunx bunsql-native-migrate redo --to 2_add_users.ts   # re-run everything down to 2_add_users.ts inclusive
```

- It composes the existing commands: a `down` of the window (the last `n`, or everything from the latest back to the `--to` target inclusive), then an `up` that re-applies exactly that window — bounded by the migration that was most recently applied before the redo, so migrations that were already pending and sort older stay pending.
- Editing an applied file normally triggers `ChecksumDriftError` on the next `up`. After a `redo` the old tracking record is gone (the down phase removed it), so the edited file re-applies cleanly with its **new** checksum — that is the point of the command. Note that the down phase runs the _current_ `down()` body against the _old_ up's effects: keep edits additive, or expect the down phase to fail if the shapes diverge.
- An unknown `--to` name throws `MigrationNotFoundError` before any writes; a name that exists but is not applied is a reported no-op (exit 0). On a fresh database `redo` prints `No migrations to redo.` and exits 0.
- If the `up` phase fails, everything the down phase reverted stays reverted — the rollbacks are printed, a warning points at them, the error propagates and the CLI exits 1. Run `up` to re-apply.
- Concurrency: both phases take the migration lock (`--lock-timeout` honors the up phase; the down phase uses the default timeout), but the window between the phases is still not atomic — `redo` is a local dev-loop tool, not something to race on production.

### Concurrent runs

Two `up` runs racing (two deploy pods, CI and a laptop) deduplicate only the tracking record against each other — without a lock both would read the same pending list and execute the migration bodies twice. `migrateUp` therefore takes an exclusive database-level lock before creating the tracking table and holds it until the run ends, so a waiter re-reads the history after it gets through and finds nothing pending. The lock is released through a `finally` path on any failure, and it dies with the connection even on a crashed process (a lock file left by a killed process is reclaimed on the next run when its recorded PID is gone):

- **PostgreSQL** — session advisory lock (`pg_try_advisory_lock` / `pg_advisory_unlock`) on a reserved connection, keyed per database.
- **MySQL/MariaDB** — `GET_LOCK` / `RELEASE_LOCK` on a reserved connection, named per database.
- **SQLite** — there is no advisory lock; instead a sidecar lock file (`<database>.bunsql-migrate.lock`, created with `O_EXCL`) is held for the whole run, so a concurrent run waits and then re-reads the history instead of re-running the bodies. The connection additionally gets `PRAGMA busy_timeout`, so any write that does contend on the file waits rather than failing immediately. In-memory databases have nothing to serialize across processes and skip the lock file.

While the lock is held, another `up` polls and waits up to `lockTimeout` seconds (default `30`, CLI `up --lock-timeout <seconds>`, `0` fails immediately). When the wait times out, `migrateUp` throws `MigrationLockError` and the CLI exits with code 4 — rerun after the first run finishes; a waiter that gets through just reports `No pending migrations.`

### Error handling

The library throws instead of exiting: connection errors, failing migrations, [`ChecksumDriftError`](#tracking-table), `InvalidIdentifierError` (an invalid `tableName`/`schema`, thrown before anything is applied), `InvalidMigrationNameError` (a `createMigration` name with path separators or other unsafe characters, thrown before a file is created), `MigrationNotFoundError` (an unknown `to` target, thrown before anything is applied), [`MigrationLockError`](#concurrent-runs) (another `up` held the lock past `lockTimeout`) and `DatabaseWaitTimeoutError` (the database did not become ready within `waitTimeout`; config mistakes like an unparseable URL or an invalid `tableName` are not retried — they throw immediately) propagate to the caller, and the driver connection is always closed. The CLI catches these and exits with a category-specific code (see [Exit codes](#exit-codes)).

`createMigration` with `git: true` throws `GitStageError` when `git add` fails (no repository, ignored path, …) — the migration file itself is still created on disk.

## License

[MIT](./LICENSE)
