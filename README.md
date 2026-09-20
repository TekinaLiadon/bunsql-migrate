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

# CI gate: same listing, but exit code 1 while migrations are pending
bunx bunsql-native-migrate status --strict

# roll back the last applied migration
bunx bunsql-native-migrate down
```

The CLI reads `DATABASE_URL` from the environment (or a `.env` file — Bun loads it automatically).

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

Files live in the migrations directory (default `./migrations`, override with `--dir` or the `MIGRATION_LIST_DIR` env var) and are applied in descending filename order. Both `.js` and `.ts` files work — Bun runs TypeScript natively — and the order is decided purely by the filename, never by the extension. `bunsql-native-migrate create` generates TypeScript stubs by default (`--lang js` for JavaScript) with an inverted timestamp prefix so newer migrations sort first:

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
- A `.sql` migration always runs inside a transaction on the runner's connection: on PostgreSQL and SQLite a failing statement rolls back the whole file and nothing is recorded; on MySQL/MariaDB DDL implicitly commits, so there only DML gets rollback protection (the same caveat as transactional JS migrations).
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
- Engine caveats: PostgreSQL and SQLite roll back everything, DDL included. On MySQL/MariaDB any DDL statement implicitly commits the current transaction, so there only DML gets rollback protection.
- The tracking record is written right after the transaction commits. A crash in that single-statement window leaves the migration applied but unrecorded — the next `up` would re-run it, so keep critical migrations idempotent (this window exists for plain `up()` migrations too, just wider).

### Migrations directory path resolution

Relative paths — whether from `--dir`, the `listDir` option or `MIGRATION_LIST_DIR` — are always resolved against the **current working directory** of the process (the same anchor Bun uses to load `.env`). Run the CLI from your project root and plain `./migrations` works as expected.

Absolute paths are passed through unchanged, which is the safe choice for CI/CD and other automation where the working directory is not guaranteed to be the repository root:

```bash
DATABASE_URL=$SECRET_URL bunx bunsql-native-migrate up --dir "$CI_WORKSPACE/migrations"
```

This resolution is part of the library contract: `resolveListDir` (and therefore every API function) always returns a fully qualified absolute path, so programmatic callers can pass either form and get identical behavior from any working directory.

## CLI reference

```
bunsql-native-migrate <init|up|down [n]|install|create [name]|mark [name]|status> [--dir <migrations-dir>] [--to <name>] [--lock-timeout <seconds>] [--table <name>] [--schema <name>] [--dry-run] [--all] [--lang <js|ts>] [--git] [--strict] [--help]
```

| Command         | What it does                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`          | Onboarding: creates the migrations directory (honoring `--dir`) with the first stub migration `..._initial.ts` and prints the next steps (set `DATABASE_URL`, run `up`). Idempotent: when the directory already contains migrations it prints a note and creates nothing.                                                                                                        |
| `up`            | Applies pending migrations (creating the tracking table if needed); each applied file prints `<file> migrated up (<duration>)`, e.g. `2_add_users.ts migrated up (120ms)` (seconds with one decimal once past a second). Prints `No pending migrations.` when there is nothing to apply. `up --to <name>` applies pending migrations in order up to and including the named one. |
| `down`          | Reverts the last applied migration; `down <n>` reverts the last `n`, `down --all` reverts everything — always most-recent-first, each printing `<file> rolled back (<duration>)`. Prints `No migrations to rollback.` when there is none.                                                                                                                                        |
| `install`       | Creates the tracking table only.                                                                                                                                                                                                                                                                                                                                                 |
| `create [name]` | Creates a stub migration file from the template — TypeScript by default, `--lang js` for JavaScript; without a `name` a random `adjective_noun` is generated.                                                                                                                                                                                                                    |
| `mark [name]`   | Baseline for an existing database: writes tracking records **without running anything**. `mark <name>` marks every pending migration up to and including the named one; `mark --all` marks all of them. Records carry the actual file checksums, so the next `up` treats them as applied (see [Baseline](#baseline-adopting-an-existing-database-mark)).                         |
| `status`        | Lists applied and pending migrations (no changes to the database except creating the tracking table if missing) and prints an `N applied, M pending` summary.                                                                                                                                                                                                                    |

| Flag                     | Applies to             | Meaning                                                                                                                                                                                 |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dir <migrations-dir>` | all                    | Migrations directory (default `./migrations`, or the `MIGRATION_LIST_DIR` env var).                                                                                                     |
| `--to <name>`            | `up`                   | Apply pending migrations up to and including the named file. An unknown name is an error (exit 1); a target that is already applied is a no-op.                                         |
| `--lock-timeout <sec>`   | `up`                   | How long to wait for the migration lock when another `up` is running, in seconds (default `30`, `0` fails immediately). On timeout: exit 1.                                             |
| `--table <name>`         | up/down/install/status | Track history in this table instead of `migrations` (see [Custom tracking table](#custom-tracking-table)).                                                                              |
| `--schema <name>`        | up/down/install/status | PostgreSQL only: create/read the tracking table in this schema (must already exist). Rejected with an error on MySQL and SQLite.                                                        |
| `--dry-run`              | `up`, `down`           | Print what a real run would apply or revert and exit — no migration bodies run, nothing is recorded, the tracking table is not even created (see [Dry run](#dry-run)).                  |
| `--all`                  | `down`, `mark`         | `down`: revert every applied migration (most-recent-first); cannot be combined with a step count. `mark`: mark every pending migration as applied; cannot be combined with a file name. |
| `--git`                  | `create`               | `git add` the created file. When staging fails, the CLI prints an error and exits 1 — the file itself stays on disk.                                                                    |
| `--lang <js\|ts>`        | `create`               | Language of the created stub. Default: `ts`. An unknown or missing value is an error (exit 1).                                                                                          |
| `--strict`               | `status`               | Exit with code 1 when migrations are pending — a gate for CI/CD pipelines. Exit 0 otherwise.                                                                                            |
| `--help`, `-h`           | —                      | Prints the usage line and exits with code 0.                                                                                                                                            |

Any failure (connection errors, a failing migration, a modified applied file) is printed and the CLI exits with code 1; the same happens for an unknown command or a call without a command.

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
  migrateStatus,
  installMigrations,
  createMigration,
  markMigrationsApplied,
  createDriver,
  ChecksumDriftError,
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
  tableName: "app_migrations", // optional: custom tracking table (default "migrations")
  schema: "private", // optional: postgres schema for the tracking table
});

const { reverted } = await migrateDown(); // reverted: string[] (most-recent-first)
await migrateDown({ steps: 3 }); // revert the last three
await migrateDown({ steps: "all" }); // revert everything

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
```

All options are optional unless stated otherwise:

| Option        | Where                                                                                     | Default                                                                                                                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `databaseUrl` | `migrateUp`, `migrateDown`, `migrateStatus`, `markMigrationsApplied`, `installMigrations` | `DATABASE_URL` env var                                                                                                                                                                                                                                                                                  |
| `listDir`     | all functions                                                                             | `MIGRATION_LIST_DIR` env var, then `./migrations` (relative paths resolve against the process cwd)                                                                                                                                                                                                      |
| `tableName`   | `migrateUp`, `migrateDown`, `migrateStatus`, `markMigrationsApplied`, `installMigrations` | `"migrations"` — a custom tracking table name (see [Custom tracking table](#custom-tracking-table))                                                                                                                                                                                                     |
| `schema`      | `migrateUp`, `migrateDown`, `migrateStatus`, `markMigrationsApplied`, `installMigrations` | — PostgreSQL only: the schema holding the tracking table (must already exist); rejected on other URLs                                                                                                                                                                                                   |
| `to`          | `migrateUp`, `markMigrationsApplied`                                                      | `migrateUp`: apply pending migrations in order up to and including the named file (unknown name throws `MigrationNotFoundError`, an already-applied target applies nothing). `markMigrationsApplied`: same boundary, but the files are only recorded as applied; omitted — mark every pending migration |
| `lockTimeout` | `migrateUp`                                                                               | `30` — seconds to wait for the migration lock while another `up` is running; `0` fails immediately; a timeout throws `MigrationLockError`                                                                                                                                                               |
| `dryRun`      | `migrateUp`, `migrateDown`                                                                | `false` — plan only: the result carries `planned: string[]` while `applied`/`reverted` stay empty (see [Dry run](#dry-run))                                                                                                                                                                             |
| `steps`       | `migrateDown`                                                                             | `1` — revert the last `n` applied migrations (`1`–`n` or `"all"`), most-recent-first                                                                                                                                                                                                                    |
| `name`        | `createMigration`                                                                         | random `adjective_noun` name                                                                                                                                                                                                                                                                            |
| `lang`        | `createMigration`                                                                         | `"ts"` — pass `"js"` for a JavaScript stub                                                                                                                                                                                                                                                              |
| `git`         | `createMigration`                                                                         | `false` — `git add` the new file                                                                                                                                                                                                                                                                        |

`migrateDown` reverts strictly in reverse apply order and stops at the first failing rollback: migrations reverted before the failure stay reverted, the failing one keeps its tracking record, and the error propagates to the caller.

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

`createDriver(url)` returns a `MigrationDriver` (`install`/`listExecuted`/`record`/`setChecksum`/`remove`/`close`) if you need custom tracking logic; `listExecuted` yields `ExecutedMigration` records (`name`, `checksum`). It also accepts the same `{ tableName, schema }` options as the API functions. Custom drivers may also implement the optional `tryLock(timeoutSeconds)` / `releaseLock()` pair to participate in [concurrent-run locking](#concurrent-runs) — without them, `migrateUp` simply runs unlocked — the optional `trackingTableExists()` used by `up`'s [dry run](#dry-run) to plan against a database that has no tracking table yet, and the optional `trackingTableCurrent()` probe that lets `up`/`down`/`status`/`mark` skip re-running `install()` when the tracking table already has its checksum column and unique index — without the probe, those commands install the table up front as before.

### Tracking table

Applied migrations are recorded in a `migrations` table with a unique name and a SHA-256 checksum. The table lives in the database you connect to: two projects pointed at the same database share one history and one `down` stack — give each project its own database. `migrate:up` aborts when an applied file has been modified after the fact:

```
1_first.js was modified after it was applied — restore the file or resolve the drift manually
```

Records created before checksums existed (checksum `NULL`) are backfilled on the next `up`.

### Custom tracking table

Several projects can point at one database without sharing a history: give each its own tracking table with `tableName` (CLI `--table`), optionally in a PostgreSQL schema with `schema` (CLI `--schema`, the schema must already exist — it is not created for you). The unique index is derived from the table name (`<table>_migration_unique`), so custom tables never collide, and the legacy checksum backfill works in custom tables too. Two concurrent `up` runs still serialize on the same per-database lock even with different tables — they share the database, after all.

Names are validated before the driver connects: an identifier of letters, digits, underscores and dollar signs, starting with a letter or underscore (PostgreSQL ≤ 63 chars, MySQL/MariaDB ≤ 47, SQLite ≤ 128; schema ≤ 63). Anything else — spaces, quotes, semicolons — throws `InvalidIdentifierError` and the CLI exits 1, so a hostile name can never reach the database. The `schema` option on a MySQL or SQLite URL is an error as well: MySQL selects the database in the URL itself and SQLite has no schemas.

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

### Concurrent runs

Two `up` runs racing (two deploy pods, CI and a laptop) deduplicate only the tracking record against each other — without a lock both would read the same pending list and execute the migration bodies twice. `migrateUp` therefore takes an exclusive database-level lock right after creating the tracking table and holds it until the run ends. The lock is released through a `finally` path on any failure, and it dies with the connection even on a crashed process:

- **PostgreSQL** — session advisory lock (`pg_try_advisory_lock` / `pg_advisory_unlock`) on a reserved connection, keyed per database.
- **MySQL/MariaDB** — `GET_LOCK` / `RELEASE_LOCK` on a reserved connection, named per database.
- **SQLite** — there is no advisory lock; the connection gets `PRAGMA busy_timeout`, so a concurrent run waits on the file write lock and fails with a busy error once the timeout is exceeded. The database file itself is the serialization point.

While the lock is held, another `up` polls and waits up to `lockTimeout` seconds (default `30`, CLI `up --lock-timeout <seconds>`, `0` fails immediately). When the wait times out, `migrateUp` throws `MigrationLockError` and the CLI exits with code 1 — rerun after the first run finishes; a waiter that gets through just reports `No pending migrations.`

### Error handling

The library throws instead of exiting: connection errors, failing migrations, [`ChecksumDriftError`](#tracking-table), `InvalidIdentifierError` (an invalid `tableName`/`schema`, thrown before anything is applied), `MigrationNotFoundError` (an unknown `to` target, thrown before anything is applied) and [`MigrationLockError`](#concurrent-runs) (another `up` held the lock past `lockTimeout`) propagate to the caller, and the driver connection is always closed. The CLI catches these and exits with code 1.

`createMigration` with `git: true` throws `GitStageError` when `git add` fails (no repository, ignored path, …) — the migration file itself is still created on disk.

## License

[MIT](./LICENSE)
