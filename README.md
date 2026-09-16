# bunsql-native-migrate

[![CI](https://github.com/TekinaLiadon/bunsql-migrate/actions/workflows/ci.yml/badge.svg)](https://github.com/TekinaLiadon/bunsql-migrate/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/bunsql-native-migrate.svg)](https://www.npmjs.com/package/bunsql-native-migrate)

Zero-ORM SQL file migrations for [Bun](https://bun.sh): PostgreSQL, MySQL/MariaDB and SQLite through the built-in `Bun.SQL` client.

No ORM, no schema diffing, no lock-in — you write plain `.js`/`.ts` migration files with `up()`/`down()` exports (optionally `up(tx)`/`down(tx)` for transactional migrations, see below) and run them with a tiny CLI or the programmatic API.

## Features

- **Bun-native** — built on the unified [`Bun.SQL`](https://bun.com/docs/runtime/sql) client (PostgreSQL, MySQL/MariaDB, SQLite). No Node.js support.
- **Zero ORM** — migrations are plain JavaScript or TypeScript files; use `sql` tagged templates or any Bun database client you like.
- **Zero dependencies**.
- **Checksums** — every applied migration is checksummed (SHA-256). A modified applied file fails the run instead of silently drifting.
- **Concurrent-safe `up`** — an advisory database lock serializes racing `up` runs (two deploy pods, CI + laptop) so a migration body never executes twice.
- **Legacy backfill** — records without a checksum are backfilled automatically on the next `up`.
- **CLI and library** — use it as `bunx bunsql-native-migrate` or import the functions directly.

## Installation

```bash
bun add bunsql-native-migrate
```

Requires Bun ≥ 1.4.2 — the version this package is developed and tested against. (The unified `Bun.SQL` client it is built on exists since Bun 1.2.21, when MySQL/MariaDB and SQLite support were added.)

## Quick start

```bash
# create migrations/<timestamp>_<name>.ts from the stub template
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
bunsql-native-migrate <up|down [n]|install|create [name]|status> [--dir <migrations-dir>] [--to <name>] [--lock-timeout <seconds>] [--all] [--lang <js|ts>] [--git] [--strict] [--help]
```

| Command         | What it does                                                                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up`            | Applies pending migrations (creating the tracking table if needed); prints `No pending migrations.` when there is nothing to apply. `up --to <name>` applies pending migrations in order up to and including the named one. |
| `down`          | Reverts the last applied migration; `down <n>` reverts the last `n`, `down --all` reverts everything — always most-recent-first. Prints `No migrations to rollback.` when there is none.                                    |
| `install`       | Creates the tracking table only.                                                                                                                                                                                            |
| `create [name]` | Creates a stub migration file from the template — TypeScript by default, `--lang js` for JavaScript; without a `name` a random `adjective_noun` is generated.                                                               |
| `status`        | Lists applied and pending migrations (no changes to the database except creating the tracking table if missing) and prints an `N applied, M pending` summary.                                                               |

| Flag                     | Applies to | Meaning                                                                                                                                         |
| ------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dir <migrations-dir>` | all        | Migrations directory (default `./migrations`, or the `MIGRATION_LIST_DIR` env var).                                                             |
| `--to <name>`            | `up`       | Apply pending migrations up to and including the named file. An unknown name is an error (exit 1); a target that is already applied is a no-op. |
| `--lock-timeout <sec>`   | `up`       | How long to wait for the migration lock when another `up` is running, in seconds (default `30`, `0` fails immediately). On timeout: exit 1.     |
| `--all`                  | `down`     | Revert every applied migration (most-recent-first). Cannot be combined with a step count.                                                       |
| `--git`                  | `create`   | `git add` the created file. When staging fails, the CLI prints an error and exits 1 — the file itself stays on disk.                            |
| `--lang <js\|ts>`        | `create`   | Language of the created stub. Default: `ts`. An unknown or missing value is an error (exit 1).                                                  |
| `--strict`               | `status`   | Exit with code 1 when migrations are pending — a gate for CI/CD pipelines. Exit 0 otherwise.                                                    |
| `--help`, `-h`           | —          | Prints the usage line and exits with code 0.                                                                                                    |

Any failure (connection errors, a failing migration, a modified applied file) is printed and the CLI exits with code 1; the same happens for an unknown command or a call without a command.

## Programmatic API

```ts
import {
  migrateUp,
  migrateDown,
  migrateStatus,
  installMigrations,
  createMigration,
  createDriver,
  ChecksumDriftError,
  MigrationLockError,
  MigrationNotFoundError,
  GitStageError,
} from "bunsql-native-migrate";

const { applied } = await migrateUp({
  databaseUrl: "postgres://user:pass@localhost:5432/app", // default: DATABASE_URL env
  listDir: "./migrations", // default: MIGRATION_LIST_DIR env or ./migrations
  to: "2_add_columns.ts", // optional: apply up to and including this file
  lockTimeout: 60, // optional: seconds to wait for the migration lock (default 30, 0 = fail fast)
});

const { reverted } = await migrateDown(); // reverted: string[] (most-recent-first)
await migrateDown({ steps: 3 }); // revert the last three
await migrateDown({ steps: "all" }); // revert everything

const status = await migrateStatus();
// status.applied: ExecutedMigration[] (name + checksum, in apply order)
// status.pending: string[] (files waiting to be applied, in apply order)

await installMigrations(); // creates the tracking table

const filename = await createMigration({ name: "add_users_table", listDir: "./migrations" });
```

All options are optional unless stated otherwise:

| Option        | Where                                                            | Default                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `databaseUrl` | `migrateUp`, `migrateDown`, `migrateStatus`, `installMigrations` | `DATABASE_URL` env var                                                                                                                                             |
| `listDir`     | all functions                                                    | `MIGRATION_LIST_DIR` env var, then `./migrations` (relative paths resolve against the process cwd)                                                                 |
| `to`          | `migrateUp`                                                      | — apply pending migrations in order up to and including the named file; an unknown name throws `MigrationNotFoundError`, an already-applied target applies nothing |
| `lockTimeout` | `migrateUp`                                                      | `30` — seconds to wait for the migration lock while another `up` is running; `0` fails immediately; a timeout throws `MigrationLockError`                          |
| `steps`       | `migrateDown`                                                    | `1` — revert the last `n` applied migrations (`1`–`n` or `"all"`), most-recent-first                                                                               |
| `name`        | `createMigration`                                                | random `adjective_noun` name                                                                                                                                       |
| `lang`        | `createMigration`                                                | `"ts"` — pass `"js"` for a JavaScript stub                                                                                                                         |
| `git`         | `createMigration`                                                | `false` — `git add` the new file                                                                                                                                   |

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

`createDriver(url)` returns a `MigrationDriver` (`install`/`listExecuted`/`record`/`setChecksum`/`remove`/`close`) if you need custom tracking logic; `listExecuted` yields `ExecutedMigration` records (`name`, `checksum`). Custom drivers may also implement the optional `tryLock(timeoutSeconds)` / `releaseLock()` pair to participate in [concurrent-run locking](#concurrent-runs) — without them, `migrateUp` simply runs unlocked.

### Tracking table

Applied migrations are recorded in a `migrations` table with a unique name and a SHA-256 checksum. The table lives in the database you connect to: two projects pointed at the same database share one history and one `down` stack — give each project its own database. `migrate:up` aborts when an applied file has been modified after the fact:

```
1_first.js was modified after it was applied — restore the file or resolve the drift manually
```

Records created before checksums existed (checksum `NULL`) are backfilled on the next `up`.

### Concurrent runs

Two `up` runs racing (two deploy pods, CI and a laptop) deduplicate only the tracking record against each other — without a lock both would read the same pending list and execute the migration bodies twice. `migrateUp` therefore takes an exclusive database-level lock right after creating the tracking table and holds it until the run ends. The lock is released through a `finally` path on any failure, and it dies with the connection even on a crashed process:

- **PostgreSQL** — session advisory lock (`pg_try_advisory_lock` / `pg_advisory_unlock`) on a reserved connection, keyed per database.
- **MySQL/MariaDB** — `GET_LOCK` / `RELEASE_LOCK` on a reserved connection, named per database.
- **SQLite** — there is no advisory lock; the connection gets `PRAGMA busy_timeout`, so a concurrent run waits on the file write lock and fails with a busy error once the timeout is exceeded. The database file itself is the serialization point.

While the lock is held, another `up` polls and waits up to `lockTimeout` seconds (default `30`, CLI `up --lock-timeout <seconds>`, `0` fails immediately). When the wait times out, `migrateUp` throws `MigrationLockError` and the CLI exits with code 1 — rerun after the first run finishes; a waiter that gets through just reports `No pending migrations.`

### Error handling

The library throws instead of exiting: connection errors, failing migrations, [`ChecksumDriftError`](#tracking-table), `MigrationNotFoundError` (an unknown `to` target, thrown before anything is applied) and [`MigrationLockError`](#concurrent-runs) (another `up` held the lock past `lockTimeout`) propagate to the caller, and the driver connection is always closed. The CLI catches these and exits with code 1.

`createMigration` with `git: true` throws `GitStageError` when `git add` fails (no repository, ignored path, …) — the migration file itself is still created on disk.

## License

[MIT](./LICENSE)
