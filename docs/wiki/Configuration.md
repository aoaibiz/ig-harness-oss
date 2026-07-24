# Configuration — IG Harness 設定リファレンス

## wrangler.toml

Workers のデプロイ設定ファイル。パス: `apps/worker/wrangler.toml`

```toml
name = "ig-harness"
main = "src/index.ts"
compatibility_date = "2024-12-01"
workers_dev = true
account_id = "YOUR_ACCOUNT_ID"

# シークレットは wrangler secret put で設定
# ここにハードコードしない

[[d1_databases]]
binding = "DB"
database_name = "instagram-harness"
database_id = "YOUR_D1_DATABASE_ID"

[[r2_buckets]]
binding = "IMAGES"
bucket_name = "your-r2-bucket"

[triggers]
crons = ["*/5 * * * *"]

# 自動送信を有効化する場合のみ（デフォルトは全 OFF — 下記「自動送信の安全スイッチ」参照）
# [vars]
# AUTO_DM_ENABLED = "1"
```

### 各フィールドの説明

| フィールド | 値 | 説明 |
|-----------|-----|------|
| `name` | `ig-harness` | Workers の名前（デプロイ先URLに影響） |
| `main` | `src/index.ts` | エントリーポイント |
| `compatibility_date` | `2024-12-01` | Workers ランタイム互換日 |
| `workers_dev` | `true` | `*.workers.dev` サブドメインを有効化 |
| `binding` | `DB` | D1 バインディング名（コード内で `c.env.DB` としてアクセス） |
| `database_name` | `instagram-harness` | D1 データベース名 |
| `database_id` | UUID | `wrangler d1 create` で取得した ID |
| `bucket_name` | R2 バケット名 | 画像アップロード用 R2 バケット |
| `crons` | `["*/5 * * * *"]` | 5分毎の Cron トリガー |

## 環境変数 / シークレット

### Workers シークレット（wrangler secret put）

| 変数名 | 必須 | 型 | 説明 |
|--------|------|-----|------|
| `IG_APP_SECRET` | 必須 | string | Meta アプリシークレット（webhook 署名検証 `X-Hub-Signature-256` に使用） |
| `IG_ACCESS_TOKEN` | 必須 | string | Instagram 長期アクセストークン |
| `IG_USER_ID` | 必須 | string | Instagram ビジネスアカウントのユーザーID |
| `IG_VERIFY_TOKEN` | 必須 | string | Webhook 購読検証トークン（`GET /webhook` の `hub.verify_token` 照合） |
| `API_KEY` | 必須 | string | REST API 認証用 Bearer トークン |
| `WORKER_URL` | 任意 | string | この Worker の公開 URL（トラッキングリンク生成等に使用） |
| `IG_USERNAME` | 任意 | string | 表示用の IG ユーザー名（`ig.me` リンク生成に使用） |
| `STRIPE_WEBHOOK_SECRET` | 任意 | string | Stripe 連携を使う場合のみ |
| `LINE_HARNESS_LINK_SECRET` | 任意 | string | オプションの LINE 連携ブリッジを使う場合のみ |

### 自動送信の安全スイッチ（AUTO_DM_ENABLED / 送信上限）

自動 DM 送信（コメントルール / エンゲージメントゲート / 追い DM / ステップ配信 / 一斉配信 / フォーム確認 DM）は **fail-closed** です。これらはシークレットではなく通常の環境変数（`[vars]` または `wrangler deploy --var`）として設定します:

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `AUTO_DM_ENABLED` | 未設定 = **全自動送信 OFF** | マスターキルスイッチ。**正確に `'1'` のときだけ**自動送信が有効。未設定・空・`'0'`・`'true'` など `'1'` 以外はすべて無効。OFF の間は、D1 に「有効」で保存済みのルール / ゲート / シナリオも発火せず、毎 Cron tick の監査付きスイープが武装済み行を自動解除する（migration 0022） |
| `AUTO_DM_HOURLY_CAP` | `100` | アカウント毎のローリング1時間あたり送信上限 |
| `AUTO_DM_DAILY_CAP` | `300` | アカウント毎のローリング24時間あたり送信上限 |
| `AUTO_DM_RECIPIENT_DAILY_CAP` | `5` | 受信者毎のローリング24時間あたり送信上限 |

- 上限は D1 の台帳で**送信前に予約**して強制される（再起動やデプロイでリセットされない）
- 有効化の手順と Meta ポリシー上の注意（24h ウィンドウ / Private Reply / マス DM 禁止）は README の「安全について」を必ず読むこと
- 緊急停止: `AUTO_DM_ENABLED` を外して（または `'1'` 以外にして）デプロイすれば全自動送信が止まる

### シークレット設定コマンド

```bash
# 全シークレットを設定
npx wrangler secret put IG_APP_SECRET
npx wrangler secret put IG_ACCESS_TOKEN
npx wrangler secret put IG_USER_ID
npx wrangler secret put IG_VERIFY_TOKEN
npx wrangler secret put API_KEY

# 設定済みシークレット一覧確認
npx wrangler secret list
```

### Env 型定義（抜粋）

```typescript
// apps/worker/src/index.ts
export type Env = {
  Bindings: {
    DB: D1Database;
    IG_APP_SECRET: string;
    IG_ACCESS_TOKEN: string;
    IG_USER_ID: string;
    IG_VERIFY_TOKEN: string;
    API_KEY: string;
    WORKER_URL: string;
    IG_USERNAME?: string;
    // 自動送信の安全スイッチ（fail-closed — 上記参照）
    AUTO_DM_ENABLED?: string;
    AUTO_DM_HOURLY_CAP?: string;
    AUTO_DM_DAILY_CAP?: string;
    AUTO_DM_RECIPIENT_DAILY_CAP?: string;
  };
};
```

### 管理画面の環境変数

Next.js 管理画面で必要な環境変数。Vercel / CF Pages のダッシュボードで設定:

| 変数名 | 説明 | 例 |
|--------|------|-----|
| `NEXT_PUBLIC_API_URL` | Workers API URL | `https://your-ig-worker.workers.dev` |

> **セキュリティ注意**: APIキーはログイン画面で入力する方式です。`NEXT_PUBLIC_*` にAPIキーを絶対に設定しないでください。クライアントバンドルに埋め込まれ、第三者から抽出可能になります。

## D1 データベースセットアップ

### 新規作成

```bash
# D1 作成
npx wrangler d1 create instagram-harness

# 出力される database_id を wrangler.toml に記入
```

### スキーマ適用

```bash
# 本番（スキーマ + マイグレーション）
pnpm db:migrate

# ローカル開発
pnpm db:migrate:local
```

### D1 ダッシュボード確認

```bash
# テーブル一覧確認
npx wrangler d1 execute instagram-harness --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

# レコード数確認
npx wrangler d1 execute instagram-harness --command="SELECT COUNT(*) FROM followers"
```

### D1 バインディング

Workers 内では `c.env.DB` として D1Database インスタンスにアクセス:

```typescript
const db = c.env.DB;
const result = await db.prepare('SELECT * FROM followers WHERE id = ?').bind(id).first();
```

## Cron トリガー

### 設定

`wrangler.toml` の `[triggers]` セクションで定義:

```toml
[triggers]
crons = ["*/5 * * * *"]
```

### Cron ハンドラ

5分毎の Cron tick は常時、トークン死活監視（実 Graph API 呼び出し）と Cron ハートビート記録を行う。**自動送信の3処理（ステップ配信 / 予約配信 / 追い DM）は `AUTO_DM_ENABLED='1'` のときのみ実行される**。OFF の間は、代わりに監査付きスイープ（`reconcileDarkAutoSend`）が D1 上の武装済みルール / ゲート / シナリオを自動解除する（migration 0022・冪等・復元可能）:

```typescript
// apps/worker/src/index.ts（要約）
async function scheduled(event, env, ctx) {
  const autoDmLit = autoSendEnabled(env);   // AUTO_DM_ENABLED === '1' ?
  if (!autoDmLit) {
    ctx.waitUntil(reconcileDarkAutoSend(env.DB));  // 武装済み行の監査付き解除
  }
  for (const account of await listIgAccounts(env.DB, { activeOnly: true })) {
    // トークン死活監視は常時実行
    if (!autoDmLit) continue;               // ← ダークゲート: 送信処理は一切走らない
    const caps = autoDmCaps(env);
    await Promise.allSettled([
      processStepDeliveries(env.DB, igClient, env.WORKER_URL, account.id, caps),      // ステップ配信
      processScheduledBroadcasts(env.DB, igClient, env.WORKER_URL, account.id, caps), // 予約配信
      processFollowupDrip(env.DB, igClient, env.WORKER_URL, undefined, ref, account.id, caps), // 追いDM
    ]);
  }
}
```

### Cron 実行間隔の変更

```toml
# 1分毎（より即時的な配信が必要な場合）
crons = ["* * * * *"]

# 10分毎（コスト節約）
crons = ["*/10 * * * *"]

# 毎時0分（1時間毎）
crons = ["0 * * * *"]
```

注意: 間隔を変更すると `next_delivery_at` の精度に影響する。5分毎が推奨。

## CORS 設定

MVP では全オリジン許可:

```typescript
// apps/worker/src/index.ts
app.use('*', cors({ origin: '*' }));
```

本番環境では管理画面のドメインに制限することを推奨:

```typescript
app.use('*', cors({
  origin: ['https://your-name-admin.pages.dev', 'https://your-domain.com'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
}));
```

## JST タイムゾーン標準化

### 設計方針

IG Harness は全タイムスタンプを **JST (UTC+9)** で統一しています。理由:
- 主要な想定利用者が日本のアカウント運用者
- Cron 配信の時間計算で UTC 変換ミスを防ぐ
- D1 (SQLite) にはタイムゾーン機能がないため、アプリケーション層で統一

### フォーマット

```
YYYY-MM-DDTHH:mm:ss.sss+09:00
```

例: `2026-03-21T14:30:00.000+09:00`

### ユーティリティ関数

```typescript
// packages/db/src/utils.ts

// 現在時刻を JST 文字列で取得
jstNow(): string
// → "2026-03-23T15:30:00.000+09:00"

// Date オブジェクトを JST 文字列に変換
toJstString(date: Date): string

// 2つのタイムスタンプをエポック比較（Z と +09:00 混在対応）
isTimeBefore(a: string, b: string): boolean
```

### API レスポンスでの表示

全 API レスポンスの `createdAt`, `updatedAt`, `scheduledAt` 等は JST 形式:

```json
{
  "createdAt": "2026-03-21T10:30:00.000+09:00",
  "updatedAt": "2026-03-21T10:30:00.000+09:00"
}
```

### 予約配信の時刻指定

配信予約はJST文字列で指定:

```bash
curl -X POST https://your-ig-worker.workers.dev/api/broadcasts \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "明日のお知らせ",
    "messageType": "text",
    "messageContent": "明日10時からセール開始！",
    "targetType": "all",
    "scheduledAt": "2026-03-24T10:00:00.000+09:00"
  }'
```

## 認証が不要なパス一覧

以下のパスは `authMiddleware` で認証をスキップします:

| パス | 理由 |
|------|------|
| `/webhook` | Meta Webhook 署名検証（`X-Hub-Signature-256`）で保護 |
| `/docs` | OpenAPI ドキュメント（公開） |
| `/openapi.json` | OpenAPI 仕様（公開） |
| `/api/affiliates/click` | クリックトラッキング（匿名アクセス可） |
| `/t/*` | トラッキングリンクリダイレクト |
| `/api/liff/*` | LIFF IDトークン認証 |
| `/auth/*` | LINE Login フロー |
| `/api/integrations/stripe/webhook` | Stripe Webhook 署名検証 |
| `/api/webhooks/incoming/*/receive` | 受信Webhook（個別シークレット検証） |
| `/api/forms/*/submit` | フォーム送信（LIFFから） |
| `/api/forms/*` (GET) | フォーム定義取得（LIFF表示用） |

## ローカル開発設定

### Workers ローカル起動

```bash
pnpm dev:worker
# → http://localhost:8787
# D1 はローカルモード（.wrangler/state/ に SQLite ファイル）
```

### 管理画面ローカル起動

```bash
pnpm dev:web
# → http://localhost:3001
# NEXT_PUBLIC_API_URL=http://localhost:8787 に設定
```

### ローカル Webhook テスト

ngrok 等で localhost をトンネル:

```bash
ngrok http 8787
# → https://xxxx.ngrok.io
# Meta アプリダッシュボードで Webhook URL を https://xxxx.ngrok.io/webhook に設定
```

## npm スクリプト一覧

```bash
pnpm dev:worker          # Workers ローカル起動
pnpm dev:web             # 管理画面ローカル起動
pnpm build               # 全パッケージビルド
pnpm deploy:worker       # Workers デプロイ
pnpm deploy:web          # 管理画面ビルド
pnpm db:migrate          # 本番D1にスキーマ適用
pnpm db:migrate:local    # ローカルD1にスキーマ適用
```
