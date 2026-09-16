# AGENTS.md

Zero-ORM SQL file migrations for Bun: PostgreSQL, MySQL/MariaDB and SQLite through the built-in `Bun.SQL` client. Published library (CLI `bunx bunsql-native-migrate` + programmatic API from `src/index.ts`) — **zero runtime dependencies**, Node.js is not supported.

**Publishing**: TS sources ship as-is — no build step, no `dist/` (Bun runs TS natively). The npm tarball is `src/` + README + LICENSE (`files` in package.json); `exports` has a `types` condition first.

## Quick Commands

```bash
bun install           # install deps
bun test              # all tests (unit tests run on SQLite, no env needed)
bun run typecheck     # tsgo --noEmit (fast native typecheck)
bun run lint          # oxlint
bun run fmt           # oxfmt (auto-fix)
bun run fmt:check     # oxfmt --check (CI form gate)
```

CI order (must pass in this sequence): `lint` → `typecheck` → `bun test` (with `DATABASE_URL` pointing at the CI postgres service) → MariaDB integration tests (explicit step with `DATABASE_URL=mariadb://…`: driver test + full cycle, see `.github/workflows/ci.yml`).

Release order (`.github/workflows/publish.yml`, triggered only by a `v*` tag push): the same CI sequence → pack smoke test (`bun test tests/pack-smoke.test.ts`) → tag/package.json version match check → `npm publish --provenance` (see Releasing).

## Releasing

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
- `tests/cycle-integration.test.ts` is the full migrate cycle (install → `up --to` (first 2) → `up` (the rest) → order → data check → repeated up → `migrateStatus` (3 applied / 0 pending) → checksum drift → `down` with `steps: 2` → `down` (the last one) → `migrateStatus` (0 applied / 3 pending)) against a real database; it is skipped unless `DATABASE_URL` is a `postgres://`/`postgresql://`/`mariadb://`/`mysql://` URL. It spawns `tests/cycle-runner.ts` in a fresh process (see Test Independence for why), so it works in the main `bun test` step (postgres) and in the MariaDB step alike. Shared-DB-safe: unique per-run migration/table names, relative assertions.
- `tests/cycle-integration.test.ts` also runs `tests/lock-runner.ts` (same skipIf) — the advisory-lock cycle: two racing `up` processes (one delayed 400 ms, migration body sleeps 1.5 s) must both exit 0 with exactly one tracking record and one data row; then a worker holds the lock via `createDriver().tryLock()` (`tests/lock-worker.ts --hold`), a second `up --lock-timeout 0` must exit 1 printing `LOCK-BUSY` (`MigrationLockError`), and a third with the default timeout must wait and exit 0. Runner prints `LOCK-OK`; the test checks exit code + marker only.
- `tests/lock.test.ts` unit-covers the lock helper with stub drivers (no DB): success release, retry-until-acquired, `MigrationLockError` on timeout without release, release on a failing run (the `finally` path), release-failure swallowed when the run failed vs propagated after success, pass-through for drivers without lock support, and `resolveLockTimeout` validation.
- `tests/up-lock.test.ts` covers `migrateUp` locking on SQLite: the run after a failed migration succeeds (lock released), `lockTimeout` validation happens before connecting, the sqlite driver exposes a working `tryLock`/`releaseLock` pair, and a second connection's write waits on the file lock up to `busy_timeout` and then throws.
- `tests/status.test.ts` covers `migrateStatus()` on SQLite (fresh database: empty status + tracking-table creation; partial apply → applied-with-checksum + pending; full apply → nothing pending; `down` returns a migration to pending; pending listed in application order). Each test gets its own temp dir + db file; needs no env and always runs.
- `tests/ts-migrations.test.ts` covers the `.js` + `.ts` migration mix on SQLite: interleaved application in pure filename order, checksum drift detection on a modified `.ts` file, `down()` on a `.ts` migration, and the generated `createMigration` stub being a runnable `.ts`. Each test gets its own temp dir; needs no env and always runs.
- `tests/pack-smoke.test.ts` packs the npm tarball (`bun pm pack`) and consumes it from a clean temp project: tarball contents (only `package.json`/README/LICENSE/`src/`), the full CLI cycle (`--help`, create → `status --strict` (exit 1, pending) → install → up → up → `status` → `status --strict` (exit 0) → down → down) against a SQLite file, the programmatic API from the installed package (including `migrateStatus` and the generated `.ts` stub), and `exports.types` resolution through `tsgo` (positive + deliberately-broken negative). It needs no env and always runs; it spawns subprocesses but never mutates `process.env` (envs are passed per-spawn).
- Local runbook: `docker compose up -d` starts three databases (see `compose.yaml`; the healthchecks gate readiness): postgres:14 and mariadb:11 exactly as CI configures them, plus mysql:8.0 for local `mysql://` verification (not in CI — host port 3307, db `bunsql`, root/mysql; it runs with `--default-authentication-plugin=mysql_native_password` because MySQL 8's default `caching_sha2_password` over plain TCP requires TLS or `allowPublicKeyRetrieval: true` on the server config side, see README). Then `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres bun test`, `DATABASE_URL=mariadb://root:mariadb@localhost:3306/mariadb bun test tests/driver-mariadb.test.ts tests/cycle-integration.test.ts` and, for MySQL, the same two integration files with `DATABASE_URL=mysql://root:mysql@localhost:3307/bunsql`; `docker compose down` afterwards if you started it just for the run.
- Tests only ever hit the database named by `DATABASE_URL` — dev databases, never production.

## Architecture

```
src/
├── index.ts        # public API surface — the only place consumers import from
├── api/            # migrateUp / migrateDown / migrateStatus / installMigrations / createMigration + shared options/errors
├── cli/            # main.ts — argv parsing, command dispatch, exit codes
├── core/           # driver selection, fs helpers (list/checksum), env access, console output, random names
└── drivers/        # postgres / mariadb / sqlite implementations of MigrationDriver
```

- `createDriver(url)` (`src/core/driver.ts`) picks the driver by URL protocol (`postgres://`/`postgresql://`, `mariadb://`/`mysql://`, `sqlite://`/`sqlite:`) with dynamic imports; unknown protocols throw. Drivers implement `MigrationDriver` (`install`/`listExecuted`/`record`/`setChecksum`/`remove`/`transaction`/`tryLock`?/`releaseLock`?/`close` — the lock pair is optional so custom drivers stay source-compatible; without it `migrateUp` runs unlocked).
- Migration semantics: files applied in **descending filename order** (`listFiles` sorts and reverses; both `.js` and `.ts` are collected into one list via `MIGRATION_EXTENSIONS`, so extension never affects order; `createMigration` generates inverted-timestamp stubs like `9999999999999_2026_09_13_name.ts` so newer sorts first — TypeScript by default, `lang: "js"` / `--lang js` for a JavaScript stub). The `migrations` table has UNIQUE on name plus a SHA-256 checksum (`Bun.CryptoHasher`); `record` deduplicates at the DB level (`ON CONFLICT DO NOTHING` / `INSERT IGNORE` / `INSERT OR IGNORE`); `up` backfills checksums for legacy records (`checksum IS NULL`) and throws `ChecksumDriftError` if an applied file changed on disk. `migrateStatus` pairs `listExecuted` with the file list (installing the tracking table first, idempotently, so it works on a fresh database) and returns applied/pending; the CLI `status` command prints them, `--strict` exits 1 while migrations are pending (CI gate). `migrateDown` accepts `steps` (positive integer or `"all"`, default 1 — CLI `down <n>` / `down --all`), reverting in reverse apply order and returning `reverted: string[]`; a failing rollback stops the loop — earlier rollbacks stay reverted, the failing record stays, the error propagates. `migrateUp` accepts `to` (CLI `up --to <name>`) — applies pending in order up to and including the named file; an unknown target throws `MigrationNotFoundError` before any writes, an already-applied target is a no-op. `migrateUp` holds an exclusive per-database lock while it works (`src/api/lock.ts`: `withMigrationLock` polls `tryLock` every 100 ms up to `lockTimeout` seconds — option on `MigrateUpOptions`, CLI `up --lock-timeout <s>`, default `DEFAULT_LOCK_TIMEOUT_SECONDS` = 30, `0` = fail fast; on timeout it throws `MigrationLockError`; release happens in a `finally`, so a failed migration frees the lock). Engines: postgres — `pg_try_advisory_lock`/`pg_advisory_unlock` on a **reserved pooled connection** (`SQL.reserve()`, session-scoped, keyed per database via `Bun.hash.wyhash` of scope + `current_database()`); mysql/mariadb — `GET_LOCK`/`RELEASE_LOCK` on a reserved connection, name = prefix + `MD5(DATABASE())`; sqlite — no advisory locks and `reserve()` throws there, so `tryLock` sets `PRAGMA busy_timeout` and concurrent runs wait on the file write lock (a lost race surfaces as a busy error, not `MigrationLockError`). The reserved-connection lifecycle lives in `src/drivers/shared.ts` (`createReservedLock`); dialects opt in via `createLock(db)`. Migration functions with a declared `tx` parameter (`up(tx)`/`down(tx)`) run inside `driver.transaction` (`Bun.SQL` `begin` on the driver connection, rollback on throw) — dispatched by function arity in `run-step.ts`; zero-argument functions keep the global-client, non-transactional behavior. On MySQL/MariaDB DDL implicitly commits, so the transaction protects only DML there.
- Error contract: the library throws (connection errors, failing migrations, `ChecksumDriftError`, `MigrationLockError`) and always closes the driver in `finally`; the CLI catches, prints via `log()` and exits with code 1. Library code never calls `process.exit`.
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
