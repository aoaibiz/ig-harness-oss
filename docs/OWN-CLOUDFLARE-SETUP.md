# 自分の Cloudflare で IG Harness を動かす

IG Harness は、運営者が自分で所有する Cloudflare と Meta のアカウントへ
デプロイして使う OSS です。このリポジトリの管理者へ秘密情報を渡す必要は
ありません。

## 1. 用意するもの

- Cloudflare アカウント
- Instagram のプロアカウント（ビジネスまたはクリエイター）
- その Instagram アカウントを管理できる Meta アカウント
- Node.js 20 以上（README の推奨は Node.js 22 以上）
- Git と、ローカルでコマンドを実行できる環境

Cloudflare の無料枠から開始できます。課金や利用上限は Cloudflare 側で
自分のアカウントを確認してください。

## 2. セットアップを開始する

作業用ターミナルで次を実行します。

```bash
npx create-ig-harness@latest
```

CLI の案内に従い、Cloudflare へログインします。D1、R2、Worker、Pages は
あなたの Cloudflare アカウントに作成されます。複数アカウントが表示された
場合は、今回の IG Harness を置くアカウントを選んでください。

## 3. Meta / Instagram を接続する

CLI が表示する手順に沿って Meta App を用意し、接続対象の Instagram
プロアカウントから取得した値を入力します。入力したアクセストークンや
App Secret は公開 Issue、Discord、スクリーンショットへ貼らないでください。

Webhook の callback URL と verify token は、CLI が表示した値を Meta の
設定画面へ登録します。URL のホストが自分の Cloudflare Worker であることを
確認してください。

## 4. 動作を確認する

セットアップ完了時に表示される管理画面を開き、作成した Owner でログイン
します。次の3点を確認します。

1. 管理画面が HTTPS で開く
2. Worker の `/api/health` が成功する
3. 接続した Instagram アカウントだけが管理画面に表示される

本番運用前に、テスト用のコメントまたは DM で自分のアカウントへの配信だけ
が行われることを確認してください。

## 5. 更新・削除

更新時はリリースノートを読み、バックアップを取ってから同梱 CLI の update
手順を実行します。利用をやめる場合は、自分の Cloudflare から Worker、Pages、
D1、R2 を削除し、Meta App 側の Webhook とトークンも失効させてください。

## 困ったとき

公開 Issue にはエラーメッセージの要点だけを書き、トークン、Cookie、秘密鍵、
実データ、Cloudflare の実 ID は伏せてください。`YOUR_...` のような
プレースホルダーへ置き換えると安全に相談できます。
