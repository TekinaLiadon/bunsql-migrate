# AGENTS.md

Zero-ORM SQL file migrations for Bun: PostgreSQL, MySQL/MariaDB and SQLite through the built-in `Bun.SQL` client. Published library (CLI `bunx bunsql-native-migrate` + programmatic API from `src/index.ts`) — **zero runtime dependencies**, Node.js is not supported.

**Publishing**: TS sources ship as-is — no build step, no `dist/` (Bun runs TS natively). The npm tarball is `src/` + README + LICENSE (`files` in package.json); `exports` has a `types` condition first.

## Quick Commands

```bash
bun install           # install deps
bun test              # all tests (unit tests run on SQLite, no env needed)
bun run test:matrix   # integration tests across the DB version matrix (compose services must be up)
bun run typecheck     # tsgo --noEmit (fast native typecheck)
bun run lint          # oxlint
bun run fmt           # oxfmt (auto-fix)
bun run fmt:check     # oxfmt --check (CI form gate)
```

CI order (must pass in this sequence): `lint` → `typecheck` → `bun test` (with `DATABASE_URL` pointing at the CI postgres service) → MariaDB integration tests (explicit step with `DATABASE_URL=mariadb://…`: driver test + full cycle, see `.github/workflows/ci.yml`). The same workflow's `matrix` job runs the full version matrix (pg 14/16/17, mariadb 10.11/11, mysql 8.0/8.4) on manual `workflow_dispatch` only — per-push CI stays single-version per engine for fast feedback; the full matrix is a pre-release gate (see Databases & Integration Tests).

Release order (`.github/workflows/publish.yml`, triggered only by a `v*` tag push): the same CI sequence → pack smoke test (`bun test tests/pack-smoke.test.ts`) → tag/package.json version match check → `npm publish --provenance` (see Releasing).

## Releasing

- Before tagging, run the full version matrix and make sure every entry is green: locally `docker compose up -d pg14 pg16 pg17 mariadb1011 mariadb11 mysql80 mysql84 && bun run test:matrix`, or dispatch the `matrix` job (workflow_dispatch) on the CI workflow.
- Bump `version` in `package.json`, tag `v<version>` and push the tag — `publish.yml` runs the full check sequence and publishes. Never publish from a non-tag ref or by hand; the tag is the only publish trigger.
- Publish path is **`npm publish --provenance --access public`** with **trusted publishing (OIDC)** — no `NODE_AUTH_TOKEN`, no npm token involved: npm matches the GitHub OIDC context against the Trusted Publisher configured on the package page (TekinaLiadon / bunsql-migrate / publish.yml). The TS-tarball needs nothing from npm (packing honors `files`, no lifecycle scripts), and the `bin` target must be written **without the `./` prefix** (`"src/cli/main.ts"`): npm's manifest normalization strips `bin` values starting with `./` (prints `was invalid and removed`, drops the entry — `bunx` would break); `tests/pack-smoke.test.ts` asserts this via `npm publish --dry-run`.
- History: v0.1.0 was published manually from a local machine (no provenance) after npm's typosquatting protection rejected the original name `bunsql-migrate` as too similar to the existing `bun-sql-migrate` — hence the rename. Everything from v0.1.1 on is CI-published with a provenance label.
- Prerequisites: the Trusted Publisher entry on npmjs.com (owner-side setup) and `id-token: write` in the workflow (already set). The old `NPM_TOKEN` repository secret is no longer used by the workflow and can be deleted.
- The pack smoke test (`tests/pack-smoke.test.ts`) is the last gate before publishing: it packs the tarball, installs it into a clean temp project and exercises CLI, API and types as a consumer.

## Task Tracking (backlog)

Bugs, tech debt and review findings are tracked in the external tasks hub — `~/project/tasks` (Backlog.md, a separate git repo). Do NOT create md-files for them inside this repository.

- The `backlog` MCP server is available in every session (tools `task_create`, `task_list`, `task_edit`, …).
- Tasks for this repo are tagged `project: bunsql-migrate` (filter: `backlog task list --project bunsql-migrate`).
- CLI fallback: `cd ~/project/tasks && backlog task list` (board: `backlog board`, web UI: `backlog browser`).
- A bug/debt found in review or audit → a backlog task (labels `bug`/`debt`/`tests`/`docs`/…, priority, file:line in the description). Architectural "we don't touch this" compromises → `backlog decision create`.
- Before fixing a reported bug, check for an existing task first: `backlog search "<essence>"`.

## Test Independence (anti-fragility)

All tests must pass in any order — the order of tests within a file and of files between each other is not a contract. Rules:

- Bun executes all test files in a single process: module-level state (env vars, caches, driver instances) lives across files.
- Never use `mock.module()` — it is NOT reverted by `mock.restore()` and poisons every other file for the rest of the process. Inject dependencies through function options instead (the public API already takes `databaseUrl`/`listDir` options for this reason).
- The default `sql` client from `import { sql } from "bun"` is a per-process singleton bound to `DATABASE_URL` at first use. In a single `bun test` process, migration files (and any direct `sql` usage) therefore always hit whatever URL was in effect at the FIRST binding — a test that runs the migrate cycle in-process against another database gets the stale client. Full-cycle tests against real databases must spawn a fresh process (see `tests/cycle-integration.test.ts` + `tests/cycle-runner.ts`); the runner asserts and prints markers, the test only checks exit code/output. In-process tests that apply migrations through explicit `options` (own sqlite file + own list dir) write **tx-style migrations** (`up(tx)`/`down(tx)` bodies using `tx`, no `import { sql } from "bun"`) — such migrations run on the driver's own connection and never touch the global singleton (see `tests/status.test.ts` / `tests/ts-migrations.test.ts`).
- A test that mutates `process.env.DATABASE_URL` must save the original in `beforeAll` and restore it in `afterAll` (see `tests/api.test.ts`) — a leftover value silently switches other files' drivers.
- Filesystem tests create their own temp dir (`mkdtempSync`) with unique migration file names and remove it in `afterAll` (`rmSync` with `force: true`).
- Migrations files created by tests always embed unique names/timestamps; a test never assumes the migrations dir is empty.
- Integration asserts against shared databases stay relative (`toContain`, `toHaveLength` on filtered arrays), never exact snapshots — other runs write to the same table.

## Databases & Integration Tests

- Unit tests run on SQLite (`sqlite://:memory:` or a temp file) — they need no env and are always green locally.
- `tests/driver-sqlite.test.ts` is the full SQLite driver cycle (install/listExecuted/record/setChecksum/remove/close) against file databases in a temp dir, including the legacy-record backfill path (a `NULL` checksum inserted directly, backfilled via `setChecksum`); it needs no env and always runs.
- `tests/driver-mariadb.test.ts` is the full driver cycle (install/listExecuted/record/setChecksum/remove/transaction, plus the legacy-table upgrade path and the `tryLock`/`releaseLock` mutual-exclusion pair) against a real MariaDB or MySQL server; it is skipped unless `DATABASE_URL` is a `mariadb://`/`mysql://` URL (`it.skipIf`), so CI without MariaDB stays green.
- `tests/driver-postgres.test.ts` is the full postgres driver cycle (install/listExecuted/record/setChecksum/remove/transaction, plus the legacy NULL-checksum backfill path and the `tryLock`/`releaseLock` mutual-exclusion pair); it is skipped unless `DATABASE_URL` is a `postgres://`/`postgresql://` URL (`it.skipIf`). In CI it runs inside the main `bun test` step, which already sets `DATABASE_URL=postgres://…` — no separate workflow step is needed.
- `tests/cycle-integration.test.ts` is the full migrate cycle (install → `up --to` (first 2) → `up` (the rest) → order → data check → repeated up → `migrateStatus` (4 applied / 0 pending) → checksum drift → `down` with `steps: 2` → `down` × 2 (the rest) → `migrateStatus` (0 applied / 4 pending)) against a real database; migrations are 2 `.js` (global `sql`), 1 `.ts` tx-style and 1 `.up.sql`/`.down.sql` pair, so the multi-statement raw-SQL path runs on every engine. It is skipped unless `DATABASE_URL` is a `postgres://`/`postgresql://`/`mariadb://`/`mysql://` URL. It spawns `tests/cycle-runner.ts` in a fresh process (see Test Independence for why), so it works in the main `bun test` step (postgres) and in the MariaDB step alike. Shared-DB-safe: unique per-run migration/table names, relative assertions.
- `tests/cycle-integration.test.ts` also runs `tests/lock-runner.ts` (same skipIf) — the advisory-lock cycle: two racing `up` processes (one delayed 400 ms, migration body sleeps 1.5 s) must both exit 0 with exactly one tracking record and one data row; then a worker holds the lock via `createDriver().tryLock()` (`tests/lock-worker.ts --hold`), a second `up --lock-timeout 0` must exit 1 printing `LOCK-BUSY` (`MigrationLockError`), and a third with the default timeout must wait and exit 0. Runner prints `LOCK-OK`; the test checks exit code + marker only.
- `tests/lock.test.ts` unit-covers the lock helper with stub drivers (no DB): success release, retry-until-acquired, `MigrationLockError` on timeout without release, release on a failing run (the `finally` path), release-failure swallowed when the run failed vs propagated after success, pass-through for drivers without lock support, and `resolveLockTimeout` validation.
- `tests/tracking-table.test.ts` unit-covers the tracking-table helpers with stub drivers (no DB): `ensureTrackingTable` installs when the `trackingTableCurrent` probe reports false or is absent and skips when it reports true; `listExecutedForPlan` treats a database without the tracking table as empty history, reads through when the probe says the table exists, and falls through to `listExecuted` on drivers without the probe. Always runs.
- `tests/up-lock.test.ts` covers `migrateUp` locking on SQLite: the run after a failed migration succeeds (lock released), `lockTimeout` validation happens before connecting, the sqlite driver exposes a working `tryLock`/`releaseLock` pair, and a second connection's write waits on the file lock up to `busy_timeout` and then throws.
- `tests/status.test.ts` covers `migrateStatus()` on SQLite (fresh database: empty status + tracking-table creation; partial apply → applied-with-checksum + pending; full apply → nothing pending; `down` returns a migration to pending; pending listed in application order). Each test gets its own temp dir + db file; needs no env and always runs.
- `tests/mark.test.ts` covers the baseline on SQLite (in-process via explicit options + spawned CLI): marking pending migrations records actual checksums without running `up()` (tables from bodies stay absent), a following `up` is a no-op without `ChecksumDriftError`, `to` marks up to and including the boundary (the rest stays pending and applies later), an already-applied target and a repeated run mark nothing, an unknown target throws `MigrationNotFoundError` before any record; CLI: `mark <file>`, `mark --all`, missing argument → exit 1, name+`--all` → exit 1. Each test gets its own temp dir; needs no env and always runs.
- `tests/ts-migrations.test.ts` covers the `.js` + `.ts` migration mix on SQLite: interleaved application in pure filename order, checksum drift detection on a modified `.ts` file, `down()` on a `.ts` migration, and the generated `createMigration` stub being a runnable `.ts`. Each test gets its own temp dir; needs no env and always runs.
- `tests/sql-migrations.test.ts` covers `.up.sql`/`.down.sql` pairs on SQLite: interleaving with `.js`/`.ts` in pure filename order, multi-statement files, rollback via the `.down.sql` pair, record-removal-without-pair (parity with a missing `down()`), checksum drift on a modified `.up.sql`, transactional rollback of a failed batch, `to` with a `.up.sql` target, and orphan `.down.sql` files being ignored. Each test gets its own temp dir; needs no env and always runs.
- `tests/table-schema.test.ts` covers the custom tracking table on SQLite: full cycle against `tableName` without creating the default table, two custom tables in one database as separate histories, keyword table names (`"order"`, quoting works), legacy NULL-checksum backfill in a custom table, `InvalidIdentifierError` for garbage names before any connection is made, and the `schema` option rejected on non-postgres URLs. Always runs.
- `tests/dry-run.test.ts` covers the preview mode on SQLite: `migrateUp dryRun` plans everything on a fresh database (creating **no** tables at all) and only pending on a partially applied one, honors `to`, still throws `ChecksumDriftError`, skips the legacy NULL-checksum backfill; `migrateDown dryRun` plans `steps`/`"all"` revert lists without rolling back; plus a spawned-CLI test (`up --dry-run` / `down --dry-run`) asserting the printed plan and an identical database before/after. Always runs.
- `tests/driver-*.test.ts` each include a custom-`tableName` driver cycle (postgres additionally in a custom `schema` created/dropped by the test; mariadb drops its custom table afterwards) — so identifier quoting/fragments are exercised on every engine in CI.
- `tests/pack-smoke.test.ts` packs the npm tarball (`bun pm pack`) and consumes it from a clean temp project: tarball contents (only `package.json`/README/LICENSE/`src/`), the full CLI cycle (`--help`, init → `create --lang js` → `status --strict` (exit 1, pending) → install → up → up → `status` → `status --strict` (exit 0) → down → down) against a SQLite file, the programmatic API from the installed package (including `migrateStatus` and the generated `.ts` stub), and `exports.types` resolution through `tsgo` (positive + deliberately-broken negative). It needs no env and always runs; it spawns subprocesses but never mutates `process.env` (envs are passed per-spawn).
- Version matrix services: `compose.yaml` defines one profile-gated service per engine version, so `docker compose up -d <name>` starts exactly that engine and nothing else: `pg14` (postgres:14, host **5434**), `pg16` (5435), `pg17` (5436), `mariadb1011` (mariadb:10.11, **3306**), `mariadb11` (mariadb:11, 3307), `mysql80` (mysql:8.0, 3308), `mysql84` (mysql:8.4, 3309). Host 5432 belongs to the Limacina project and 5433 to spice-postgres, so the postgres range starts at 5434. Credentials: postgres `postgres`/`postgres` (db `postgres`), mariadb `root`/`mariadb` (db `mariadb`), mysql `root`/`mysql` (db `bunsql`). MySQL runs with `mysql_native_password` because `Bun.SQL` rejects `caching_sha2_password` over plain TCP — 8.0 via `--default-authentication-plugin=mysql_native_password`, 8.4 via `--mysql-native-password=ON` **plus** the `docker/mysql84-init.sql` init script (8.4 only re-enables the plugin server-side; accounts are still created with `caching_sha2_password`, so the script recreates `root@%` with the native plugin; init scripts run only on a fresh data volume). Every service has a healthcheck. `docker compose down` afterwards if you started services just for the run (`docker compose rm -sfv <name>` to also drop the data volume).
- `bun run test:matrix [names]` (`scripts/matrix.ts`) runs the integration test files against the whole matrix in one command: it probes each target's port first (engines that are down are SKIPped with a `docker compose up -d <name>` hint), runs `bun test` per target with that target's `DATABASE_URL` (unsetting any inherited `MIGRATION_LIST_DIR`), and prints an `OK/FAIL/SKIP — name — engine — seconds` summary. Exit codes: 1 on any failure or when nothing was reachable, 2 on an unknown target name. Single-engine manual runs use the URLs behind those ports, e.g. `DATABASE_URL=postgres://postgres:postgres@localhost:5434/postgres bun test` or `DATABASE_URL=mysql://root:mysql@localhost:3309/bunsql bun test tests/driver-mariadb.test.ts tests/cycle-integration.test.ts`.
- CI matrix decision (recorded): per-push CI runs one version per engine (postgres:14 + mariadb:11 services in the `verify` job, unchanged) — a 7-entry matrix on every push would slow every PR for a zero-dep package. The full matrix is a pre-release gate, implemented twice: locally via `bun run test:matrix`, and as the `matrix` job in `.github/workflows/ci.yml` (manual `workflow_dispatch` only; each entry `docker run`s the engine in a step, waits for its healthcheck, runs the same two integration files against it).
- Version support process: a new engine version → add the compose service (with profile + next free port), a `TARGETS` entry in `scripts/matrix.ts`, a matrix include in `ci.yml` and a README row — in the same change; an EOL version → remove it from all four places. Supported matrix: postgres 14/16/17, mysql 8.0/8.4, mariadb 10.11/11.x; SQLite follows the SQLite bundled with the Bun runtime (no services).
- Tests only ever hit the database named by `DATABASE_URL` — dev databases, never production.

## Architecture

```
src/
├── index.ts        # public API surface — the only place consumers import from
├── api/            # migrateUp / migrateDown / migrateStatus / installMigrations / createMigration / initMigrations / markMigrationsApplied + shared options/errors
├── cli/            # main.ts — argv parsing, command dispatch, exit codes
├── core/           # driver selection, fs helpers (list/checksum), identifier validation/quoting, env access, console output, random names
└── drivers/        # postgres / mariadb / sqlite implementations of MigrationDriver
```

- `createDriver(url, { tableName?, schema? })` (`src/core/driver.ts`) picks the driver by URL protocol (`postgres://`/`postgresql://`, `mariadb://`/`mysql://`, `sqlite://`/`sqlite:`) with dynamic imports; unknown protocols throw, and `schema` on a non-postgres URL is rejected there before any connection is made. Drivers implement `MigrationDriver` (`install`/`listExecuted`/`record`/`setChecksum`/`remove`/`transaction`/`trackingTableExists`?/`trackingTableCurrent`?/`tryLock`?/`releaseLock`?/`close` — the optional pairs keep custom drivers source-compatible; without the lock pair `migrateUp` runs unlocked, without `trackingTableExists` dry-run `up`/`down` on a table-less database falls through to `listExecuted`, without `trackingTableCurrent` every non-dry-run run (re)installs the tracking table unconditionally).
- Migration semantics: files applied in **descending filename order** (`listFiles` sorts and reverses; `.js`, `.ts` and `.up.sql` are collected into one list via `MIGRATION_EXTENSIONS`, so the extension never affects order; `createMigration` generates inverted-timestamp stubs like `9999999999999_2026_09_13_name.ts` so newer sorts first — TypeScript by default, `lang: "js"` / `--lang js` for a JavaScript stub; it does not generate `.sql` pairs). `.up.sql` files are pure-SQL migrations: the `.up.sql` **filename is the migration identity** (record name, `status` entry, `--to` target); the optional `.down.sql` sibling is its rollback, and a missing pair behaves exactly like a missing `down()` export — the tracking record is removed with a warn, nothing is executed. `init` (CLI `init`, `src/api/init.ts`) is onboarding composition: it creates the migrations directory (via `createMigration`, so `resolveListDir`/`--dir` apply) with the first `..._initial.ts` stub, or — when the directory already holds migrations — reports them and creates nothing (idempotent); it prints the next steps (set `DATABASE_URL`, run `up`) through `log()`. `loadMigration` (`src/api/load-migration.ts`) normalizes both kinds into `up`/`down` step closures: JS modules are dynamically imported, while a `.sql` step is an arity-1 closure that runs `tx.file(path)` — so it is dispatched by arity into `driver.transaction` and executes the whole file as one multi-statement batch (atomic on postgres/sqlite; on mysql DDL implicitly commits, DML keeps rollback protection). The tracking table has UNIQUE on name plus a SHA-256 checksum (`Bun.CryptoHasher`); `record` deduplicates at the DB level (`ON CONFLICT DO NOTHING` / `INSERT IGNORE` / `INSERT OR IGNORE`); `up` backfills checksums for legacy records (`checksum IS NULL`) and throws `ChecksumDriftError` if an applied file changed on disk. `migrateStatus` pairs `listExecuted` with the file list (ensuring the tracking table first via `ensureTrackingTable` in `src/api/tracking-table.ts` — the shared install gate used by `up`/`down`/`status`/`mark`: for drivers with the `trackingTableCurrent` probe (table + checksum column + unique index, one value-bound query) it installs only when the probe reports the table missing or outdated, so a legacy table gets upgraded and an up-to-date one skips re-install) and returns applied/pending; the CLI `status` command prints them, `--strict` exits 1 while migrations are pending (CI gate). `migrateDown` accepts `steps` (positive integer or `"all"`, default 1 — CLI `down <n>` / `down --all`), reverting in reverse apply order and returning `reverted: string[]`; a real `down` ensures the tracking table first, so a fresh database (never `up`-ed) yields `No migrations to rollback.` instead of a driver error, while `down --dry-run` plans through `trackingTableExists` without creating anything; a failing rollback stops the loop — earlier rollbacks stay reverted, the failing record stays, the error propagates. `migrateUp` accepts `to` (CLI `up --to <name>`) — applies pending in order up to and including the named file; an unknown target throws `MigrationNotFoundError` before any writes, an already-applied target is a no-op. `migrateUp` holds an exclusive per-database lock while it works (`src/api/lock.ts`: `withMigrationLock` polls `tryLock` every 100 ms up to `lockTimeout` seconds — option on `MigrateUpOptions`, CLI `up --lock-timeout <s>`, default `DEFAULT_LOCK_TIMEOUT_SECONDS` = 30, `0` = fail fast; on timeout it throws `MigrationLockError`; release happens in a `finally`, so a failed migration frees the lock). Engines: postgres — `pg_try_advisory_lock`/`pg_advisory_unlock` on a **reserved pooled connection** (`SQL.reserve()`, session-scoped, keyed per database via `Bun.hash.wyhash` of scope + `current_database()`); mysql/mariadb — `GET_LOCK`/`RELEASE_LOCK` on a reserved connection, name = prefix + `MD5(DATABASE())`; sqlite — no advisory locks and `reserve()` throws there, so `tryLock` sets `PRAGMA busy_timeout` and concurrent runs wait on the file write lock (a lost race surfaces as a busy error, not `MigrationLockError`). The reserved-connection lifecycle lives in `src/drivers/shared.ts` (`createReservedLock`); dialects opt in via `createLock(db)`. Migration functions with a declared `tx` parameter (`up(tx)`/`down(tx)`) run inside `driver.transaction` (`Bun.SQL` `begin` on the driver connection, rollback on throw) — dispatched by function arity in `run-step.ts`; zero-argument functions keep the global-client, non-transactional behavior. On MySQL/MariaDB DDL implicitly commits, so the transaction protects only DML there. `dryRun` (`MigrateUpOptions`/`MigrateDownOptions`, CLI `up|down --dry-run`) is a read-only preview: `up` skips `install()` and the lock, computes the same pending list (drift check included — a preview must predict a real failure; the legacy NULL-checksum backfill is the one write it skips), and on a database without the tracking table treats the history as empty via the optional driver probe `trackingTableExists()` (value-bound existence query per dialect; pg uses `current_schema()` unless `schema` is set) — `down --dry-run` plans through the same probe; `down` resolves `steps` and plans the revert list without the loop. Results carry the plan in the optional `planned: string[]` while `applied`/`reverted` stay empty (backward-compatible shape); the CLI prints `Would apply/revert N migration(s).`
  `markMigrationsApplied` (`src/api/mark.ts`, CLI `mark <name>` / `mark --all`, API option `to`) is the baseline path: it ensures the tracking table (`ensureTrackingTable`), resolves the same pending list as `up` (sliced to `to` inclusive; unknown target → `MigrationNotFoundError` before any record, already-applied target → no-op) and writes records with the actual file checksums through `driver.record` — `up()`/`down()` are never called, `loadMigration` is never touched. No lock: `record` deduplicates at the DB level, so re-runs and racing marks converge; a later `up` treats marked files as applied (checksums match) and a later `down` runs their `down()` bodies for real.
- Tracking-table placement: `tableName`/`schema` options on `MigrateOptions` (CLI `--table` / `--schema`, also `createDriver(url, { tableName, schema })`) let several projects share one database with separate histories. Names are validated by `src/core/identifiers.ts` **before the driver connects** (`/^[A-Za-z_][A-Za-z0-9_$]*$/`; table: pg ≤ 63, mysql ≤ 47 — the derived `<table>_migration_unique` index name must fit MySQL's 64-char limit —, sqlite ≤ 128; schema: pg only, ≤ 63) and garbage throws `InvalidIdentifierError`. Quoting is per dialect (`"name"` for pg/sqlite, `` `name` `` for mysql) and the quoted identifier goes into queries as a **nested `db.unsafe(quoted)` fragment inside a tagged template** — Bun inlines nested `unsafe` fragments as raw SQL while values stay bound; never concatenate user input, never bind identifiers as params. Postgres gotchas: the index name must NOT be schema-qualified (`CREATE INDEX` rejects `"schema"."index"`, and indexes always land in the table's schema anyway); the schema must exist — it is not created. The lock key stays per-database, so different tables in one database still serialize their `up` runs.
- Error contract: the library throws (connection errors, failing migrations, `ChecksumDriftError`, `MigrationLockError`, `InvalidIdentifierError` (bad `tableName`/`schema`, plus the plain `Error` rejecting `schema` on non-postgres URLs)) and always closes the driver in `finally`; the CLI catches, prints via `log()` and exits with code 1. Library code never calls `process.exit`.
- All user-facing console output goes through `log()` from `src/core/console.ts` — no bare `console.*` outside it.
- New public API functions are exported only via `src/index.ts`; keep `src/api/*` and `src/core/*` free of CLI concerns, `src/cli/*` free of business logic.

## Toolchain

- **Runtime**: Bun (not Node), ≥ 1.4.2 (developed and tested against 1.4.2; the unified `Bun.SQL` client requires ≥ 1.2.21). `bun-types` is pinned to the **exact** runtime version (never `latest` — types ahead of the runtime promise non-existent APIs); `@types/node` is an explicit devDep for the same reason.
- **Type check**: `tsgo` (TypeScript native preview), not `tsc`.
- **Linter**: oxlint (not ESLint). Config: `.oxlintrc.json` — categories `correctness`/`suspicious` as `error`, import plugin enabled; additional rules enabled as `warn` (see config) — warns do not break CI.
- **Formatter**: oxfmt (not Prettier).
- **Test runner**: `bun:test` (describe/it/expect from bun:test).
- **Zero dependencies** is a product feature: never add a runtime dependency. Solve it with Bun built-ins (`Bun.sql`, `bun:sqlite`, `Bun.CryptoHasher`, `Bun.file`, `node:fs`/`node:path`).

## Conventions

- Strict TypeScript: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (see `tsconfig.json`). Index access returns `T | undefined` — narrow it, don't assert.
- ESM imports use explicit `.js` extensions for relative paths (`import { createDriver } from "../core/driver.js"`), matching `moduleResolution: "bundler"` + runtime ESM.
- Use `type` imports for types (`import { type MigrateOptions, ChecksumDriftError }`), inline style.
- Naming: data "whose → what" (`migrationChecksum`), functions "what they do" (`installMigrations`, `resolveListDir`).
- Readability: small functions, early return, no deep nesting.
- No comments in code. The code explains itself: clear names, small functions. Comments only on explicit request.
- Runtime input (argv, env vars, URLs) is validated explicitly — TS types do not validate runtime: parse args in one place (`parseArgs`), parse/guard `DATABASE_URL` before use (`getDatabaseUrl`), `new URL()` in a try/catch with a domain error.
- Atomic related changes: several sequential writes forming one state change (config + sidecar file, manifest + its install records) either all succeed together or roll back entirely; plan for a failure in the middle of the chain.

## Rules

1. If a task adds functionality, write the tests first, then the implementation — only when the task needs tests.
2. Match the existing code style.
3. If a block of code or function is used 3+ times — extract and reuse it.
4. Avoid global variables where possible (options objects over module state; env reads go through `src/core/env.ts`).
5. Handle errors and surface them through the library's error contract (throw typed errors like `ChecksumDriftError`; the CLI formats and exits).
6. Prefer inverted `if` (early return) over plain `if`.
7. Naming: data «whose → what», functions «what it does».
8. When changing the public API, update `README.md` and `src/index.ts` exports in the same change.
9. On larger changes (new API function, driver, CLI command, scripts, CI) — update AGENTS.md within the same change.
10. Never commit or push unless the user explicitly asked — even if the change is needed on a remote branch (e.g. for CI on a PR). Changes stay in the working tree; committing and pushing is the user's call.
11. Tests cover both the happy flow and failure scenarios: identify at which step a failure is possible and how the app must handle it.
12. Keep code coverage at 90% or higher.
13. Any non-trivial arithmetic (sums of several numbers, multi-digit multiplication/division, percentages, proportions, unit/currency conversions, date math, statistics — anything beyond trivial mental math with small numbers) is executed as code (a shell one-liner or REPL), never computed in your head.

## Skills

- No project-local skills yet; domain-specific conventions (a new driver, the CLI, a new API area) go into a local skill, not here.
- A local skill is updated in the same change as the code it describes.
- Reusable project-wide pieces (helpers, shared checks) are listed in a dedicated skill once they exist — so they are reused, not duplicated.
- AGENTS.md stays global-only: no changelogs, task logs, or README duplicates.

## Priority of Sources

On conflict, higher priority first:

1. User instructions (in chat).
2. AGENTS.md.
3. Local skills.

## Dependencies

- Runtime dependencies remain banned — zero-deps is a product feature (see Toolchain).
- A new dev dependency: pick a popular, widely-used package, ask the user before installing, and use a version released more than 7 days ago — no fresh releases.

## Exceptions

Conscious global compromises that stand above the general rules:

- Zero runtime dependencies — stands above the general dependency policy.
- Bun-only: Node.js is not supported; Bun built-ins over portable libraries.
- TS sources ship as-is — no build step, no `dist/`.
- Migrations apply in descending filename order — intentional; do not "fix" it to ascending.
