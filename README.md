# bunsql-native-migrate

[![CI](https://github.com/TekinaLiadon/bunsql-migrate/actions/workflows/ci.yml/badge.svg)](https://github.com/TekinaLiadon/bunsql-migrate/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/bunsql-native-migrate.svg)](https://www.npmjs.com/package/bunsql-native-migrate)

Zero-ORM SQL file migrations for [Bun](https://bun.sh): PostgreSQL, MySQL/MariaDB and SQLite through the built-in `Bun.SQL` client.

No ORM, no schema diffing, no lock-in — you write plain `.js` migration files with `up()`/`down()` exports and run them with a tiny CLI or the programmatic API.

## Features

- **Bun-native** — built on the unified [`Bun.SQL`](https://bun.com/docs/runtime/sql) client (PostgreSQL, MySQL/MariaDB, SQLite). No Node.js support.
- **Zero ORM** — migrations are plain JavaScript files; use `sql` tagged templates or any Bun database client you like.
- **Zero dependencies**.
- **Checksums** — every applied migration is checksummed (SHA-256). A modified applied file fails the run instead of silently drifting.
- **Legacy backfill** — records without a checksum are backfilled automatically on the next `up`.
- **CLI and library** — use it as `bunx bunsql-native-migrate` or import the functions directly.

## Installation

```bash
bun add bunsql-native-migrate
```

Requires Bun ≥ 1.4.2 — the version this package is developed and tested against. (The unified `Bun.SQL` client it is built on exists since Bun 1.2.21, when MySQL/MariaDB and SQLite support were added.)

## Quick start

```bash
# create migrations/<timestamp>_<name>.js from the stub template
bunx bunsql-native-migrate create add_users_table

# create the tracking table (optional — up() does it automatically)
bunx bunsql-native-migrate install

# apply pending migrations
bunx bunsql-native-migrate up

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

Files live in the migrations directory (default `./migrations`, override with `--dir` or the `MIGRATION_LIST_DIR` env var) and are applied in descending filename order. `bunsql-native-migrate create` generates names with an inverted timestamp prefix so newer migrations sort first:

```
9999999999999_2026_09_13_add_users_table.js
```

### Migrations directory path resolution

Relative paths — whether from `--dir`, the `listDir` option or `MIGRATION_LIST_DIR` — are always resolved against the **current working directory** of the process (the same anchor Bun uses to load `.env`). Run the CLI from your project root and plain `./migrations` works as expected.

Absolute paths are passed through unchanged, which is the safe choice for CI/CD and other automation where the working directory is not guaranteed to be the repository root:

```bash
DATABASE_URL=$SECRET_URL bunx bunsql-native-migrate up --dir "$CI_WORKSPACE/migrations"
```

This resolution is part of the library contract: `resolveListDir` (and therefore every API function) always returns a fully qualified absolute path, so programmatic callers can pass either form and get identical behavior from any working directory.

## CLI reference

```
bunsql-native-migrate <up|down|install|create [name]> [--dir <migrations-dir>] [--git] [--help]
```

| Command         | What it does                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `up`            | Applies pending migrations (creating the tracking table if needed); prints `No pending migrations.` when there is nothing to apply. |
| `down`          | Reverts the last applied migration; prints `No migrations to rollback.` when there is none.                                         |
| `install`       | Creates the tracking table only.                                                                                                    |
| `create [name]` | Creates a stub migration file from the template; without a `name` a random `adjective_noun` is generated.                           |

| Flag                     | Applies to | Meaning                                                                                                              |
| ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `--dir <migrations-dir>` | all        | Migrations directory (default `./migrations`, or the `MIGRATION_LIST_DIR` env var).                                  |
| `--git`                  | `create`   | `git add` the created file. When staging fails, the CLI prints an error and exits 1 — the file itself stays on disk. |
| `--help`, `-h`           | —          | Prints the usage line and exits with code 0.                                                                         |

Any failure (connection errors, a failing migration, a modified applied file) is printed and the CLI exits with code 1; the same happens for an unknown command or a call without a command.

## Programmatic API

```ts
import {
  migrateUp,
  migrateDown,
  installMigrations,
  createMigration,
  createDriver,
  ChecksumDriftError,
  GitStageError,
} from "bunsql-native-migrate";

const { applied } = await migrateUp({
  databaseUrl: "postgres://user:pass@localhost:5432/app", // default: DATABASE_URL env
  listDir: "./migrations", // default: MIGRATION_LIST_DIR env or ./migrations
});

const { reverted } = await migrateDown(); // reverted: string | null

await installMigrations(); // creates the tracking table

const filename = await createMigration({ name: "add_users_table", listDir: "./migrations" });
```

All options are optional unless stated otherwise:

| Option        | Where                                           | Default                                                                                            |
| ------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `databaseUrl` | `migrateUp`, `migrateDown`, `installMigrations` | `DATABASE_URL` env var                                                                             |
| `listDir`     | all functions                                   | `MIGRATION_LIST_DIR` env var, then `./migrations` (relative paths resolve against the process cwd) |
| `name`        | `createMigration`                               | random `adjective_noun` name                                                                       |
| `git`         | `createMigration`                               | `false` — `git add` the new file                                                                   |

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

`createDriver(url)` returns a `MigrationDriver` (`install`/`listExecuted`/`record`/`setChecksum`/`remove`/`close`) if you need custom tracking logic; `listExecuted` yields `ExecutedMigration` records (`name`, `checksum`).

### Tracking table

Applied migrations are recorded in a `migrations` table with a unique name and a SHA-256 checksum. The table lives in the database you connect to: two projects pointed at the same database share one history and one `down` stack — give each project its own database. `migrate:up` aborts when an applied file has been modified after the fact:

```
1_first.js was modified after it was applied — restore the file or resolve the drift manually
```

Records created before checksums existed (checksum `NULL`) are backfilled on the next `up`.

### Error handling

The library throws instead of exiting: connection errors, failing migrations and [`ChecksumDriftError`](#tracking-table) propagate to the caller, and the driver connection is always closed. The CLI catches these and exits with code 1.

`createMigration` with `git: true` throws `GitStageError` when `git add` fails (no repository, ignored path, …) — the migration file itself is still created on disk.

## License

[MIT](./LICENSE)
