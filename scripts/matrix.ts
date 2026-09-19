import { createConnection } from "node:net";

interface MatrixTarget {
  name: string;
  engine: string;
  url: string;
  files: string[];
}

const POSTGRES_FILES = ["tests/driver-postgres.test.ts", "tests/cycle-integration.test.ts"];
const MYSQL_FAMILY_FILES = ["tests/driver-mariadb.test.ts", "tests/cycle-integration.test.ts"];

const TARGETS: MatrixTarget[] = [
  {
    name: "pg14",
    engine: "postgres 14",
    url: "postgres://postgres:postgres@localhost:5434/postgres",
    files: POSTGRES_FILES,
  },
  {
    name: "pg16",
    engine: "postgres 16",
    url: "postgres://postgres:postgres@localhost:5435/postgres",
    files: POSTGRES_FILES,
  },
  {
    name: "pg17",
    engine: "postgres 17",
    url: "postgres://postgres:postgres@localhost:5436/postgres",
    files: POSTGRES_FILES,
  },
  {
    name: "mariadb1011",
    engine: "mariadb 10.11",
    url: "mariadb://root:mariadb@localhost:3306/mariadb",
    files: MYSQL_FAMILY_FILES,
  },
  {
    name: "mariadb11",
    engine: "mariadb 11",
    url: "mariadb://root:mariadb@localhost:3307/mariadb",
    files: MYSQL_FAMILY_FILES,
  },
  {
    name: "mysql80",
    engine: "mysql 8.0",
    url: "mysql://root:mysql@localhost:3308/bunsql",
    files: MYSQL_FAMILY_FILES,
  },
  {
    name: "mysql84",
    engine: "mysql 8.4",
    url: "mysql://root:mysql@localhost:3309/bunsql",
    files: MYSQL_FAMILY_FILES,
  },
];

interface TargetOutcome {
  target: MatrixTarget;
  status: "ok" | "fail" | "skip";
  seconds: number;
}

function isReachable(url: string): Promise<boolean> {
  const parsed = new URL(url);
  const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
  return new Promise((resolve) => {
    const socket = createConnection({ host: parsed.hostname, port });
    const settle = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

async function runTarget(target: MatrixTarget): Promise<TargetOutcome> {
  const startedAt = Date.now();
  if (!(await isReachable(target.url))) {
    return { target, status: "skip", seconds: 0 };
  }

  console.log(`\n=== ${target.name} (${target.engine}) — ${target.url} ===`);
  const env = { ...process.env, DATABASE_URL: target.url };
  delete env["MIGRATION_LIST_DIR"];
  const proc = Bun.spawn(["bun", "test", ...target.files], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  return {
    target,
    status: exitCode === 0 ? "ok" : "fail",
    seconds: (Date.now() - startedAt) / 1000,
  };
}

function printSummary(outcomes: TargetOutcome[]): void {
  console.log("\n=== Matrix summary ===");
  for (const { target, status, seconds } of outcomes) {
    const mark = status === "ok" ? "OK  " : status === "fail" ? "FAIL" : "SKIP";
    const timing = status === "skip" ? "" : ` ${seconds.toFixed(1)}s`;
    console.log(`${mark}  ${target.name.padEnd(14)} ${target.engine}${timing}`);
  }
}

const filters = process.argv.slice(2);
const unknown = filters.filter((name) => !TARGETS.some((target) => target.name === name));
if (unknown.length > 0) {
  console.error(
    `Unknown matrix target(s): ${unknown.join(", ")} — known: ${TARGETS.map((target) => target.name).join(", ")}`,
  );
  process.exit(2);
}

const selected =
  filters.length > 0 ? TARGETS.filter((target) => filters.includes(target.name)) : TARGETS;

const outcomes: TargetOutcome[] = [];
for (const target of selected) {
  outcomes.push(await runTarget(target));
}
printSummary(outcomes);

const failures = outcomes.filter((outcome) => outcome.status === "fail");
const skips = outcomes.filter((outcome) => outcome.status === "skip");
for (const { target } of skips) {
  console.log(`skipped ${target.name} — start it with: docker compose up -d ${target.name}`);
}
if (failures.length > 0) {
  process.exit(1);
}
if (skips.length === outcomes.length) {
  console.error(
    "No matrix target was reachable — start the databases first (docker compose up -d <name>).",
  );
  process.exit(1);
}
