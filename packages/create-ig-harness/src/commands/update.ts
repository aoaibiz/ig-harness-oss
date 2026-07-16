import * as p from "@clack/prompts";
import pc from "picocolors";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ensureAuth } from "../steps/auth.js";
import { setAccountId, wrangler } from "../lib/wrangler.js";
import { deployWorker } from "../steps/deploy-worker.js";
import { applyD1Migrations } from "../steps/database.js";
import { join } from "node:path";
import { execa } from "execa";

interface DeployedState {
  // apiKey is accepted only to scrub/upgrade legacy state files.
  apiKey?: string;
  workerUrl?: string;
  adminUrl?: string;
  workerName?: string;
  d1DatabaseId?: string;
  d1DatabaseName?: string;
  r2BucketName?: string;
  adminProjectName?: string;
  accountId?: string;
}

type CompleteDeployedState = Required<Omit<DeployedState, "apiKey">>;

export function requireCompleteDeployedState(state: DeployedState | null): CompleteDeployedState {
  const required: Array<keyof CompleteDeployedState> = [
    "workerUrl", "adminUrl", "workerName", "d1DatabaseId", "d1DatabaseName",
    "r2BucketName", "adminProjectName", "accountId",
  ];
  const missing = required.filter((key) => !state?.[key]);
  if (!state || missing.length > 0) {
    throw new Error(
      `.ig-harness-deployed.json が不足しています（${missing.join(", ") || "file"}）。` +
      "別のCloudflare資源へ誤配線しないためupdateを停止しました。初回setupを再開してください。",
    );
  }
  return state as CompleteDeployedState;
}

export function loadDeployedState(repoDir: string): DeployedState | null {
  // After a successful setup the state file is deleted, so we look for a
  // persisted "deployed" state alongside the repo instead.
  const path = join(repoDir, ".ig-harness-deployed.json");
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as DeployedState;
      const clean: DeployedState = {
        workerUrl: raw.workerUrl,
        adminUrl: raw.adminUrl,
        workerName: raw.workerName,
        d1DatabaseId: raw.d1DatabaseId,
        d1DatabaseName: raw.d1DatabaseName,
        // The previous public release created `${workerName}-images` but did
        // not persist that value. Its deterministic setup naming rule lets us
        // upgrade old state without listing or guessing Cloudflare resources.
        r2BucketName: raw.r2BucketName ??
          (raw.workerName ? `${raw.workerName}-images` : undefined),
        accountId: raw.accountId,
        adminProjectName: raw.adminProjectName ??
          (raw.apiKey ? `ih-admin-${raw.apiKey.slice(0, 8)}` : undefined),
      };
      writeFileSync(path, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600 });
      chmodSync(path, 0o600);
      return clean;
    } catch {
      return null;
    }
  }
  return null;
}

export function writeAdminBuildEnv(webDir: string, workerUrl: string): void {
  mkdirSync(webDir, { recursive: true });
  writeFileSync(
    join(webDir, ".env.production"),
    `NEXT_PUBLIC_API_URL=${workerUrl}\n`,
  );
}

export async function runUpdate(repoDir: string): Promise<void> {
  p.intro(pc.bgMagenta(pc.black(" Instagram Harness アップデート ")));

  // Validate the exact target before authenticating or making any Cloudflare
  // call. There is deliberately no template/default fallback for update.
  const deployedState = requireCompleteDeployedState(loadDeployedState(repoDir));
  await ensureAuth();
  setAccountId(deployedState.accountId);
  const s = p.spinner();

  // Run pending migrations against the user's actual D1 (use saved name)
  s.start("マイグレーション確認中...");
  try {
    await applyD1Migrations(repoDir, {
      accountId: deployedState.accountId,
      databaseId: deployedState.d1DatabaseId,
      databaseName: deployedState.d1DatabaseName,
    });
    s.stop("マイグレーション完了");
  } catch (error) {
    s.stop("マイグレーション失敗");
    throw error;
  }

  // Redeploy Worker. The committed wrangler.toml is a TEMPLATE with our dev
  // bindings, so we MUST overwrite it with the user's saved D1/R2/account
  // bindings before deploying. Missing state was rejected above; never deploy
  // the repository template as a fallback.
  s.start("Worker 再デプロイ中...");
  await deployWorker({
    repoDir,
    d1DatabaseId: deployedState.d1DatabaseId,
    d1DatabaseName: deployedState.d1DatabaseName,
    r2BucketName: deployedState.r2BucketName,
    workerName: deployedState.workerName,
    accountId: deployedState.accountId,
  });
  s.stop("Worker 再デプロイ完了");

  // Rebuild and redeploy Admin UI
  const webDir = join(repoDir, "apps/web");

  s.start("Admin UI 再デプロイ中...");
  writeAdminBuildEnv(webDir, deployedState.workerUrl);
  await execa("pnpm", ["run", "build"], { cwd: webDir });

  await wrangler(
    ["pages", "deploy", "out", "--project-name", deployedState.adminProjectName, "--commit-dirty=true"],
    { cwd: webDir },
  );
  s.stop(`Admin UI 再デプロイ完了 (${deployedState.adminProjectName})`);

  p.outro(pc.green("アップデート完了！"));
}
