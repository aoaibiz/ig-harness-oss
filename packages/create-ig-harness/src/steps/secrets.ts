import * as p from "@clack/prompts";
import { wrangler } from "../lib/wrangler.js";

interface SecretsOptions {
  workerName: string;
  metaAppSecret: string;
  metaAccessToken: string;
  metaVerifyToken: string;
  igUserId: string;
  apiKey: string;
  /**
   * Shared secret used by LINE Harness to call POST /api/followers/link-line.
   * Optional and never generated or printed by the base IG setup. Without an
   * explicitly coordinated value, the cross-platform UUID link route fails closed.
   */
  lineHarnessLinkSecret?: string;
}

export function buildSecretBindings(options: SecretsOptions): Record<string, string> {
  return {
    IG_APP_SECRET: options.metaAppSecret,
    IG_ACCESS_TOKEN: options.metaAccessToken,
    IG_VERIFY_TOKEN: options.metaVerifyToken,
    IG_USER_ID: options.igUserId,
    API_KEY: options.apiKey,
    ...(options.lineHarnessLinkSecret
      ? { LINE_HARNESS_LINK_SECRET: options.lineHarnessLinkSecret }
      : {}),
  };
}

export async function setSecrets(options: SecretsOptions): Promise<void> {
  const s = p.spinner();
  s.start("シークレット設定中...");

  // Secret names must match the Env interface in apps/worker/src/index.ts.
  const secrets = buildSecretBindings(options);

  for (const [name, value] of Object.entries(secrets)) {
    await wrangler(["secret", "put", name, "--name", options.workerName], {
      input: value,
    });
  }

  s.stop("シークレット設定完了");
}
