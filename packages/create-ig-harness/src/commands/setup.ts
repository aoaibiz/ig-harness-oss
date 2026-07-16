import * as p from "@clack/prompts";
import pc from "picocolors";
import { chmodSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { checkDeps } from "../steps/check-deps.js";
import { ensureAuth, getAccountId } from "../steps/auth.js";
import { promptMetaCredentials } from "../steps/prompt.js";
import { createDatabase } from "../steps/database.js";
import { createR2Bucket } from "../steps/r2-bucket.js";
import { deployWorker } from "../steps/deploy-worker.js";
import { deployAdmin } from "../steps/deploy-admin.js";
import { setSecrets } from "../steps/secrets.js";
import { generateMcpConfig } from "../steps/mcp-config.js";
import { showWebhookGuide } from "../steps/webhook-guide.js";
import { generateApiKey } from "../lib/crypto.js";
import { setAccountId } from "../lib/wrangler.js";

interface SetupState {
  d1DatabaseId?: string;
  d1DatabaseName?: string;
  r2BucketName?: string;
  workerName?: string;
  accountId?: string;
  workerUrl?: string;
  adminUrl?: string;
  resourceSuffix?: string;
  completedSteps: string[];
}

function getStatePath(repoDir: string): string {
  return join(repoDir, ".ig-harness-setup.json");
}

export function loadState(repoDir: string): SetupState {
  const path = getStatePath(repoDir);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      // Old versions persisted Meta credentials and the generated API key here.
      // Copy only non-secret restart metadata, then immediately rewrite the file
      // so an interrupted legacy setup is scrubbed before any network action.
      const state: SetupState = {
        d1DatabaseId: typeof raw.d1DatabaseId === "string" ? raw.d1DatabaseId : undefined,
        d1DatabaseName: typeof raw.d1DatabaseName === "string" ? raw.d1DatabaseName : undefined,
        r2BucketName: typeof raw.r2BucketName === "string" ? raw.r2BucketName : undefined,
        workerName: typeof raw.workerName === "string" ? raw.workerName : undefined,
        accountId: typeof raw.accountId === "string" ? raw.accountId : undefined,
        workerUrl: typeof raw.workerUrl === "string" ? raw.workerUrl : undefined,
        adminUrl: typeof raw.adminUrl === "string" ? raw.adminUrl : undefined,
        resourceSuffix: typeof raw.resourceSuffix === "string" ? raw.resourceSuffix : undefined,
        completedSteps: Array.isArray(raw.completedSteps)
          ? raw.completedSteps.filter((step): step is string =>
              typeof step === "string" && step !== "credentials" && step !== "secrets")
          : [],
      };
      saveState(repoDir, state);
      return state;
    } catch {
      // corrupt file, start fresh
    }
  }
  return { completedSteps: [] };
}

export function saveState(repoDir: string, state: SetupState): void {
  const path = getStatePath(repoDir);
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

function isDone(state: SetupState, step: string): boolean {
  return state.completedSteps.includes(step);
}

function markDone(state: SetupState, step: string): void {
  if (!state.completedSteps.includes(step)) {
    state.completedSteps.push(step);
  }
}

export async function runSetup(repoDir: string): Promise<void> {
  p.intro(pc.bgMagenta(pc.black(" Instagram Harness セットアップ ")));

  p.note(
    `${pc.bold("📖 セットアップガイド (スクリーンショット付き):")}\n   ${pc.cyan("https://harness-wiki.pages.dev/article/ig-harness-complete-setup-guide")}\n\n   各ステップで詰まったらこのページを参照してください。`,
    "はじめに",
  );

  const state = loadState(repoDir);

  if (state.completedSteps.length > 0) {
    p.log.info(
      `前回の途中から再開します（完了済み: ${state.completedSteps.join(", ")}）`,
    );
  }

  // Step 1: Check dependencies
  await checkDeps();

  // Step 2: Authenticate with Cloudflare
  await ensureAuth();

  // Step 2.5: Get account ID
  if (!state.accountId) {
    const accountId = await getAccountId();
    state.accountId = accountId;
    saveState(repoDir, state);
    p.log.success(`Cloudflare アカウント: ${accountId}`);
  }
  setAccountId(state.accountId);

  // Step 3: Keep all Meta credentials in this process only. On a resumed run
  // the member re-enters them; the setup state deliberately stores no secrets.
  const credentials = await promptMetaCredentials();

  // Step 4: Generate a fresh key for this run. A retry rotates the Worker secret
  // instead of recovering a plaintext key from disk.
  const apiKey = generateApiKey();

  // Step 4.5: Generate a random suffix once and reuse it across worker / D1 / R2.
  // Guarantees no name collision with anyone else's deploy on the same account.
  if (!state.resourceSuffix) {
    state.resourceSuffix = randomBytes(4).toString("hex");
    saveState(repoDir, state);
  }
  const baseName = `ig-harness-${state.resourceSuffix}`;
  const workerName = state.workerName ?? baseName;
  const databaseName = state.d1DatabaseName ?? baseName;
  const r2BucketName = state.r2BucketName ?? `${baseName}-images`;
  state.workerName = workerName;
  state.r2BucketName = r2BucketName;
  saveState(repoDir, state);

  // Step 5: Create R2 bucket for image hosting
  if (!isDone(state, "r2bucket")) {
    await createR2Bucket(r2BucketName);
    markDone(state, "r2bucket");
    saveState(repoDir, state);
  } else {
    p.log.success(`R2 バケット: 作成済み（${r2BucketName}）（スキップ）`);
  }

  // Step 6: Create D1 database + run migrations
  if (!isDone(state, "database")) {
    const { databaseId, databaseName: createdName } = await createDatabase(
      repoDir,
      databaseName,
    );
    state.d1DatabaseId = databaseId;
    state.d1DatabaseName = createdName;
    markDone(state, "database");
    saveState(repoDir, state);
  } else {
    p.log.success(`D1 データベース: 作成済み（${state.d1DatabaseId}）`);
  }

  // Step 7: Deploy Worker
  if (!isDone(state, "worker")) {
    const { workerUrl } = await deployWorker({
      repoDir,
      d1DatabaseId: state.d1DatabaseId!,
      d1DatabaseName: state.d1DatabaseName!,
      r2BucketName: state.r2BucketName!,
      workerName,
      accountId: state.accountId!,
    });
    state.workerUrl = workerUrl;
    markDone(state, "worker");
    saveState(repoDir, state);
  } else {
    p.log.success(`Worker: デプロイ済み（${state.workerUrl}）`);
  }

  // Step 8: Always inject from memory. This also rotates secrets safely when a
  // previous run stopped after Worker deploy but before final completion.
  await setSecrets({
    workerName,
    metaAppSecret: credentials.metaAppSecret,
    metaAccessToken: credentials.metaAccessToken,
    metaVerifyToken: credentials.metaVerifyToken,
    igUserId: credentials.igUserId,
    apiKey,
  });

  // Step 9: Deploy Admin UI via CF Pages
  const adminProjectName = `ih-admin-${state.resourceSuffix}`;
  if (!isDone(state, "admin")) {
    const { adminUrl } = await deployAdmin({
      repoDir,
      workerUrl: state.workerUrl!,
      projectName: adminProjectName,
    });
    state.adminUrl = adminUrl;
    markDone(state, "admin");
    saveState(repoDir, state);
  } else {
    p.log.success(`Admin UI: デプロイ済み（${state.adminUrl}）`);
  }

  // Step 10: Show webhook setup guide
  showWebhookGuide({
    workerUrl: state.workerUrl!,
    metaVerifyToken: credentials.metaVerifyToken,
  });

  // Step 11: Generate MCP config
  const addMcp = await p.confirm({
    message: "API Keyを含むMCP設定を権限600の .mcp.json に保存しますか？（Claude Code / Cursor 用）",
  });
  if (addMcp && !p.isCancel(addMcp)) {
    await generateMcpConfig({ workerUrl: state.workerUrl!, apiKey, repoDir });
  }

  // Step 12: Show completion screen
  p.note(
    [
      `${pc.bold("① Webhook を Meta Developer Console で設定してください:")}`,
      `   Callback URL: ${pc.cyan(`${state.workerUrl}/webhook`)}`,
      `   Verify Token: ${pc.cyan(credentials.metaVerifyToken)}`,
      `   → developers.facebook.com/apps → Webhooks → Instagram`,
      `   → messages, messaging_postbacks, comments を購読`,
      "",
      `${pc.bold("② Meta App 公開時に Dashboard へ貼り付ける URL:")}`,
      `   Privacy Policy URL:   ${pc.cyan(`${state.workerUrl}/privacy-policy`)}`,
      `   Data Deletion URL:    ${pc.cyan(`${state.workerUrl}/data-deletion`)}`,
      `   Terms of Service URL: ${pc.cyan(`${state.workerUrl}/terms-of-service`)}`,
      `   → developers.facebook.com/apps → アプリ設定 → ベーシック`,
      `   → アプリアイコン (1024x1024 PNG) と カテゴリ (ビジネス) も忘れずに`,
      "",
      `${pc.bold("③ 管理画面:")}`,
      `   ${pc.cyan(state.adminUrl!)}`,
      "",
      `${pc.bold("④ API Key:")}`,
      `   ${pc.dim(apiKey)}`,
      `   → この値は再表示できません。安全な場所に保存してください`,
    ].join("\n"),
    "セットアップ完了！",
  );

  // Write a lightweight deployed-state file so `update` can resolve the exact
  // non-secret Cloudflare resources without re-running the full wizard.
  const deployedStatePath = join(repoDir, ".ig-harness-deployed.json");
  writeFileSync(
    deployedStatePath,
    JSON.stringify(
      {
        workerUrl: state.workerUrl,
        adminUrl: state.adminUrl,
        adminProjectName,
        workerName: state.workerName,
        d1DatabaseId: state.d1DatabaseId,
        d1DatabaseName: state.d1DatabaseName,
        r2BucketName: state.r2BucketName,
        accountId: state.accountId,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  chmodSync(deployedStatePath, 0o600);

  // Clean up non-secret restart state after a complete run.
  const statePath = getStatePath(repoDir);
  if (existsSync(statePath)) {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(statePath);
  }

  p.note(
    `${pc.bold("📖 詳しい解説 (Meta App公開手順、トラブルシュート、運用Tips):")}\n   ${pc.cyan("https://harness-wiki.pages.dev/article/ig-harness-complete-setup-guide")}`,
    "セットアップガイド",
  );

  p.outro(pc.green("Instagram Harness を使い始めましょう 🚀"));
}
