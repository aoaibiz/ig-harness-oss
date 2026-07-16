import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyD1Migrations,
  buildMigrationBaselineSql,
  createDatabase,
} from "./database.js";

const dirs: string[] = [];

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ig-harness-db-"));
  dirs.push(dir);
  mkdirSync(join(dir, "packages/db"), { recursive: true });
  mkdirSync(join(dir, "packages/db/migrations"), { recursive: true });
  writeFileSync(join(dir, "packages/db/schema.sql"), "CREATE TABLE IF NOT EXISTS ready (id TEXT);\n");
  writeFileSync(
    join(dir, "packages/db/migrations/0001_non_idempotent.sql"),
    "ALTER TABLE ready ADD COLUMN migrated TEXT;\n",
  );
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createDatabase", () => {
  it("applies the canonical schema and returns only after it succeeds", async () => {
    const repo = fixtureRepo();
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === "create") return 'database_id = "test-database-id"';
      return "ok";
    });

    const result = await createDatabase(repo, "ig-test", run);

    expect(result.databaseName).toBe("ig-test");
    expect(run).toHaveBeenNthCalledWith(2, [
      "d1", "execute", "ig-test", "--remote", "--file", join(repo, "packages/db/schema.sql"),
    ]);
    expect(run).toHaveBeenNthCalledWith(3, [
      "d1", "execute", "ig-test", "--remote", "--command",
      buildMigrationBaselineSql(repo),
    ]);
    expect(buildMigrationBaselineSql(repo)).toContain("0001_non_idempotent.sql");
  });

  it("fails closed when schema application fails", async () => {
    const repo = fixtureRepo();
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === "create") return 'database_id = "test-database-id"';
      throw new Error("schema rejected");
    });

    await expect(createDatabase(repo, "ig-test", run)).rejects.toThrow("schema rejected");
  });

  it("records the fresh schema as the Wrangler migration baseline", async () => {
    const repo = fixtureRepo();
    const applied = new Set<string>();
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === "create") return 'database_id = "test-database-id"';
      if (args.includes("--command")) {
        for (const match of args.at(-1)!.matchAll(/VALUES \('([^']+)'\)/g)) {
          applied.add(match[1]);
        }
      }
      return "ok";
    });

    await createDatabase(repo, "ig-test", run);

    expect(applied).toEqual(new Set(["0001_non_idempotent.sql"]));
  });
});

describe("legacy database upgrade", () => {
  it("uses a temporary config pinned to the saved account and D1 IDs", async () => {
    const repo = fixtureRepo();
    const configSnapshots: string[] = [];
    const configPaths: string[] = [];
    const run = vi.fn(async (args: string[]) => {
      const configIndex = args.indexOf("--config");
      expect(configIndex).toBeGreaterThan(-1);
      const configPath = args[configIndex + 1];
      configPaths.push(configPath);
      configSnapshots.push(readFileSync(configPath, "utf8"));
      return "ok";
    });

    await applyD1Migrations(repo, {
      accountId: "test-account-id",
      databaseId: "test-database-id",
      databaseName: "ig-harness-a1b2c3d4",
    }, run, "0001_non_idempotent.sql");

    expect(configSnapshots).toHaveLength(2);
    for (const config of configSnapshots) {
      expect(config).toContain('account_id = "test-account-id"');
      expect(config).toContain('database_id = "test-database-id"');
      expect(config).toContain('database_name = "ig-harness-a1b2c3d4"');
      expect(config).toContain(
        `migrations_dir = "${join(repo, "packages/db/migrations")}"`,
      );
    }
    expect(run).toHaveBeenLastCalledWith([
      "d1", "migrations", "apply", "ig-harness-a1b2c3d4", "--remote",
      "--config", expect.stringMatching(/ig-harness-d1-[^/]+\/wrangler\.toml$/),
    ], { cwd: join(repo, "packages/db") });
    expect(configPaths.every((path) => !existsSync(path))).toBe(true);
  });

  it("fills an existing partial legacy ledger without overwriting future rows", () => {
    const repo = fixtureRepo();
    const migrationsDir = join(repo, "packages/db/migrations");
    const legacyName = "0001_non_idempotent.sql";
    const secondLegacyName = "0002_second_legacy.sql";
    const futureName = "0003_future.sql";
    writeFileSync(join(migrationsDir, secondLegacyName), "SELECT 1;\n");
    writeFileSync(join(migrationsDir, futureName), "SELECT 1;\n");
    const databasePath = join(repo, "partial-ledger.sqlite");
    runSqlite(databasePath, [
      "CREATE TABLE d1_migrations (",
      "id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "name TEXT UNIQUE,",
      "applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
      `INSERT INTO d1_migrations (name) VALUES ('${legacyName}');`,
      `INSERT INTO d1_migrations (name) VALUES ('${futureName}');`,
    ].join("\n"));

    runSqlite(
      databasePath,
      buildMigrationBaselineSql(repo, secondLegacyName),
    );

    expect(querySqlite(databasePath, "SELECT name FROM d1_migrations ORDER BY name"))
      .toEqual([
        { name: legacyName },
        { name: secondLegacyName },
        { name: futureName },
      ]);
  });

  it("is resolved by real Wrangler and upgrades its local SQLite store", async () => {
    const repo = fixtureRepo();
    const migrationsDir = join(repo, "packages/db/migrations");
    const persistDir = join(repo, ".wrangler-test-state");
    writeFileSync(
      join(migrationsDir, "0002_future.sql"),
      "CREATE TABLE future_feature (id TEXT PRIMARY KEY);\n",
    );
    let initialized = false;
    let futureTableOutput = "";
    const run = async (args: string[], options?: { cwd?: string }): Promise<string> => {
      const localArgs = args.map((arg) => arg === "--remote" ? "--local" : arg);
      const configIndex = localArgs.indexOf("--config");
      const configPath = localArgs[configIndex + 1];
      if (!initialized) {
        initialized = true;
        runWranglerLocal([
          "d1", "execute", "ig-harness-a1b2c3d4", "--local",
          "--command", "CREATE TABLE ready (id TEXT, migrated TEXT);",
          "--config", configPath,
        ], persistDir, options?.cwd);
      }
      const output = runWranglerLocal(localArgs, persistDir, options?.cwd);
      if (localArgs[1] === "migrations" && localArgs[2] === "apply") {
        futureTableOutput = runWranglerLocal([
          "d1", "execute", "ig-harness-a1b2c3d4", "--local", "--json",
          "--command", "SELECT name FROM sqlite_master " +
            "WHERE type = 'table' AND name = 'future_feature';",
          "--config", configPath,
        ], persistDir, options?.cwd);
      }
      return output;
    };

    await applyD1Migrations(repo, {
      accountId: "test-account-id",
      databaseId: "test-database-id",
      databaseName: "ig-harness-a1b2c3d4",
    }, run, "0001_non_idempotent.sql");

    expect(futureTableOutput).toContain('"name": "future_feature"');
  }, 20_000);

  it("baselines only legacy migrations, then applies a future migration in real SQLite", () => {
    const repo = fixtureRepo();
    const migrationsDir = join(repo, "packages/db/migrations");
    const legacyName = "0001_non_idempotent.sql";
    const futureName = "0002_future.sql";
    writeFileSync(
      join(migrationsDir, futureName),
      "CREATE TABLE future_feature (id TEXT PRIMARY KEY);\n",
    );

    const databasePath = join(repo, "legacy.sqlite");
    runSqlite(databasePath, "CREATE TABLE ready (id TEXT, migrated TEXT);");
    expect(() => runSqlite(
      databasePath,
      "ALTER TABLE ready ADD COLUMN migrated TEXT;",
    )).toThrow(/duplicate column name/i);

    runSqlite(databasePath, buildMigrationBaselineSql(repo, legacyName));
    const applied = new Set(
      querySqlite(databasePath, "SELECT name FROM d1_migrations")
        .map((row) => String(row.name)),
    );
    expect(applied).toEqual(new Set([legacyName]));

    for (const name of [legacyName, futureName]) {
      if (applied.has(name)) continue;
      runSqlite(databasePath, readFileSync(join(migrationsDir, name), "utf8"));
      runSqlite(
        databasePath,
        `INSERT INTO d1_migrations (name) VALUES ('${name}');`,
      );
    }

    expect(querySqlite(
      databasePath,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'future_feature'",
    )).toEqual([{ name: "future_feature" }]);
    expect(querySqlite(databasePath, "SELECT name FROM d1_migrations ORDER BY name"))
      .toEqual([{ name: legacyName }, { name: futureName }]);
  });
});

function runSqlite(databasePath: string, sql: string): void {
  execFileSync("sqlite3", [databasePath], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function querySqlite(databasePath: string, sql: string): Array<Record<string, unknown>> {
  const output = execFileSync("sqlite3", ["-json", databasePath, sql], {
    encoding: "utf8",
  });
  return output.trim() ? JSON.parse(output) : [];
}

function runWranglerLocal(args: string[], persistDir: string, cwd?: string): string {
  try {
    return execFileSync(
      join(process.cwd(), "../../node_modules/.bin/wrangler"),
      [...args, "--persist-to", persistDir],
      {
        cwd,
        encoding: "utf8",
        input: "y\n".repeat(10),
        env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    throw new Error(stderr?.toString() || String(error));
  }
}
