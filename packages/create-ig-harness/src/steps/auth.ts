import * as p from "@clack/prompts";
import {
  isWranglerAuthenticated,
  hasApiToken,
  setApiToken,
  wrangler,
  wranglerInteractive,
} from "../lib/wrangler.js";

const CLOUDFLARE_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * Keep the member-owned Cloudflare token in this CLI process only. Nothing in
 * the setup state or the IG Mate service receives it. Wrangler reads the token
 * from this environment while the process is alive.
 */
export async function connectWithApiToken(
  rawToken: string,
  setToken: (token: string | undefined) => void = setApiToken,
  verify: () => Promise<boolean> = isWranglerAuthenticated,
): Promise<void> {
  const token = rawToken.trim();
  if (!token) throw new Error("Cloudflare API tokenを入力してください。");

  setToken(token);
  try {
    const authenticated = await verify();
    if (!authenticated) {
      throw new Error(
        "Cloudflare API tokenを確認できませんでした。権限と対象アカウントを確認してください。",
      );
    }
  } catch (error) {
    setToken(undefined);
    throw error;
  }
}

export async function ensureAuth(): Promise<void> {
  const s = p.spinner();
  s.start("Cloudflare 認証チェック中...");

  const authenticated = await isWranglerAuthenticated();
  if (authenticated) {
    s.stop(
      hasApiToken()
        ? "自分のCloudflareに接続済み（API token）"
        : "自分のCloudflareに接続済み（ブラウザ認証）",
    );
    return;
  }

  // An invalid inherited token takes priority over Wrangler OAuth. Remove it,
  // then re-check any existing browser login before asking the user again.
  if (hasApiToken()) {
    setApiToken(undefined);
    if (await isWranglerAuthenticated()) {
      s.stop("自分のCloudflareに接続済み（ブラウザ認証）");
      return;
    }
  }
  s.stop("自分のCloudflareへの接続が必要です");

  const method = await p.select({
    message: "Cloudflareの接続方法を選んでください",
    options: [
      {
        value: "token",
        label: "API tokenを使う（おすすめ）",
        hint: "このPCの処理中だけ使い、保存しません",
      },
      {
        value: "browser",
        label: "ブラウザでログインする",
        hint: "Cloudflareの認証画面が開きます",
      },
    ],
  });
  if (p.isCancel(method)) {
    p.cancel("セットアップをキャンセルしました");
    process.exit(0);
  }

  if (method === "token") {
    p.note(
      [
        `作成画面: ${CLOUDFLARE_TOKEN_URL}`,
        "必要なAccount権限:",
        "  Workers Scripts: Edit / D1: Edit",
        "  Workers R2 Storage: Edit / Cloudflare Pages: Edit",
        "  Account Settings: Read",
        "必要なUser権限:",
        "  Memberships: Read / User Details: Read",
        "対象Accountは『自分のアカウントだけ』に絞ってください。",
      ].join("\n"),
      "API tokenの作り方",
    );

    const token = await p.password({
      message: "作成したAPI tokenを貼り付けてください（画面には表示されません）",
      validate(value) {
        if (!value?.trim()) return "API tokenを入力してください";
      },
    });
    if (p.isCancel(token)) {
      p.cancel("セットアップをキャンセルしました");
      process.exit(0);
    }

    await connectWithApiToken(token as string);
    p.log.success("自分のCloudflareへの接続を確認しました");
    return;
  }

  p.log.info("ブラウザが開きます。自分のCloudflareアカウントでログインしてください。");

  await wranglerInteractive(["login"]);

  const nowAuthenticated = await isWranglerAuthenticated();
  if (!nowAuthenticated) {
    p.cancel("Cloudflare ログインに失敗しました。もう一度試してください。");
    process.exit(1);
  }

  p.log.success("Cloudflare ログイン完了");
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export function parseCloudflareAccounts(output: string): CloudflareAccount[] {
  const accounts = [...output.matchAll(/│\s*([^│\r\n]+?)\s*│\s*([a-f0-9]{32})\s*│/gi)]
    .map((match) => ({ name: match[1].trim(), id: match[2] }));
  return accounts.filter((account, index) =>
    accounts.findIndex((candidate) => candidate.id === account.id) === index);
}

/** Get one explicitly determined account ID for this member-owned deploy. */
export async function getAccountId(): Promise<string> {
  const output = await wrangler(["whoami"]);
  const accounts = parseCloudflareAccounts(output);
  if (accounts.length === 0) {
    throw new Error(
      "Cloudflare アカウント ID を取得できません。wrangler whoami の出力を確認してください。",
    );
  }
  if (accounts.length === 1) return accounts[0].id;

  const selected = await p.select({
    message: "IG Mateを作るCloudflareアカウントを選んでください",
    options: accounts.map((account) => ({
      value: account.id,
      label: account.name,
      hint: `Account ID末尾 …${account.id.slice(-6)}`,
    })),
  });
  if (p.isCancel(selected)) {
    p.cancel("セットアップをキャンセルしました");
    process.exit(0);
  }
  return selected as string;
}
