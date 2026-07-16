import * as p from "@clack/prompts";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrangler, WranglerError } from "../lib/wrangler.js";

interface DatabaseResult {
  databaseId: string;
  databaseName: string;
}

interface D1MigrationTarget {
  accountId: string;
  databaseId: string;
  databaseName: string;
}

// `2632ff4` (the previous public release) shipped migrations through 0016,
// while its setup path executed them without Wrangler's ledger. Never make
// this dynamic: a future migration must remain pending on a legacy install.
export const LEGACY_MIGRATION_BASELINE = "0016_messages_log_gate_source.sql";

function migrationNames(repoDir: string): string[] {
  const migrationsDir = join(repoDir, "packages/db/migrations");
  if (!existsSync(migrationsDir)) {
    throw new Error("D1 migrations ディレクトリが見つかりません");
  }
  const names = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.length === 0) throw new Error("D1 migration が見つかりません");
  for (const name of names) {
    if (!/^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name)) {
      throw new Error(`不正なD1 migration名です: ${name}`);
    }
  }
  return names;
}

export function buildMigrationBaselineSql(
  repoDir: string,
  throughName?: string,
): string {
  const allNames = migrationNames(repoDir);
  let names = allNames;
  if (throughName) {
    const baselineIndex = allNames.indexOf(throughName);
    if (baselineIndex < 0) {
      throw new Error(`legacy baseline migration が見つかりません: ${throughName}`);
    }
    names = allNames.slice(0, baselineIndex + 1);
  }
  return [
    "CREATE TABLE IF NOT EXISTS d1_migrations (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "name TEXT UNIQUE, " +
      "applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
    ...names.map((name) =>
      `INSERT OR IGNORE INTO d1_migrations (name) VALUES ('${name}');`),
  ].join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export async function applyD1Migrations(
  repoDir: string,
  target: D1MigrationTarget,
  runWrangler: typeof wrangler = wrangler,
  legacyBaselineName = LEGACY_MIGRATION_BASELINE,
): Promise<void> {
  const databaseDir = join(repoDir, "packages/db");
  const configDir = mkdtempSync(join(tmpdir(), "ig-harness-d1-"));
  const configPath = join(configDir, "wrangler.toml");
  const config = [
    `account_id = ${tomlString(target.accountId)}`,
    "",
    "[[d1_databases]]",
    'binding = "DB"',
    `database_name = ${tomlString(target.databaseName)}`,
    `database_id = ${tomlString(target.databaseId)}`,
    `migrations_dir = ${tomlString(join(databaseDir, "migrations"))}`,
    "",
  ].join("\n");

  writeFileSync(configPath, config, { mode: 0o600, flag: "wx" });
  const configArgs = ["--config", configPath];
  const runOptions = { cwd: databaseDir };
  try {
    // A previous `wrangler migrations apply` can leave an empty or partial
    // ledger when it fails. Fill every migration known to the legacy release
    // idempotently on every retry; the fixed cutoff keeps future migrations
    // pending for Wrangler to apply normally.
    await runWrangler([
      "d1", "execute", target.databaseName, "--remote",
      "--command", buildMigrationBaselineSql(repoDir, legacyBaselineName),
      ...configArgs,
    ], runOptions);
    await runWrangler([
      "d1", "migrations", "apply", target.databaseName, "--remote",
      ...configArgs,
    ], runOptions);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

export async function createDatabase(
  repoDir: string,
  databaseName: string,
  runWrangler: typeof wrangler = wrangler,
): Promise<DatabaseResult> {
  const s = p.spinner();

  // Create D1 database
  s.start("D1 データベース作成中...");
  let databaseId: string;
  try {
    const output = await runWrangler(["d1", "create", databaseName]);
    // Parse database_id from TOML or JSON format
    const tomlMatch = output.match(/database_id\s*=\s*"([^"]+)"/);
    const jsonMatch = output.match(/"database_id"\s*:\s*"([^"]+)"/);
    const uuidMatch = output.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    const match = tomlMatch || jsonMatch || uuidMatch;
    if (!match) {
      throw new Error(`D1 ID をパースできません: ${output}`);
    }
    databaseId = match[1];
    s.stop("D1 データベース作成完了");
  } catch (error) {
    if (
      error instanceof WranglerError &&
      error.stderr.includes("already exists")
    ) {
      s.stop("D1 データベースは既に存在します");
      const listOutput = await runWrangler(["d1", "list", "--json"]);
      const databases = JSON.parse(listOutput);
      const db = databases.find(
        (d: { name: string }) => d.name === databaseName,
      );
      if (!db) {
        throw new Error("既存の D1 データベースが見つかりません");
      }
      databaseId = db.uuid;
    } else {
      throw error;
    }
  }

  // Run base schema
  const schemaFile = join(repoDir, "packages/db/schema.sql");
  s.start("テーブル作成中...");
  if (!existsSync(schemaFile)) throw new Error("D1 schema.sql が見つかりません");

  // schema.sql is the canonical latest schema and uses idempotent CREATE IF NOT
  // EXISTS statements. Historical migrations are for upgrades; replaying them
  // after the latest base schema produces duplicate-column errors. Most
  // importantly, never swallow a D1 error and announce a false success.
  try {
    await runWrangler([
      "d1",
      "execute",
      databaseName,
      "--remote",
      "--file",
      schemaFile,
    ]);
    // schema.sql is the canonical latest schema for a fresh install. Record the
    // migrations already represented by that schema using Wrangler's own ledger
    // shape, so the first update does not replay non-idempotent ALTER statements.
    await runWrangler([
      "d1",
      "execute",
      databaseName,
      "--remote",
      "--command",
      buildMigrationBaselineSql(repoDir),
    ]);
  } catch (error) {
    s.stop("テーブル作成失敗");
    throw error;
  }

  s.stop("テーブル作成完了");

  return { databaseId, databaseName };
}
