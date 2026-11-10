# 実機 (iPhone / Android) での動作確認手順

スマートフォンでは **HTTPS で公開された URL** が必要です (カメラ・Service Worker・Web Crypto・WebRTC はすべて安全な接続でしか動かないため)。PC の開発サーバーに `http://192.168.x.x` でつないでも、QR 読み取りやオフライン起動は確認できません。

## 1. HTTPS で公開する (どれか 1 つ)

### A. GitHub Pages (採用: リポジトリを public にして使用)
非公開 (private) リポジトリで Pages を使うには有料プランが必要なため、リポジトリを公開して使います。

1. GitHub のリポジトリ → **Settings → General → Danger Zone → Change repository visibility** で **Public** にする
2. **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
3. **Actions → CI → Run workflow** (以降は push するたびに自動で公開)
4. 完了すると `https://gangidenset.github.io/family-hub/` で開けます (URL は Actions の deploy-pages ジョブに表示)

> 注意: Pages の URL は、リポジトリが非公開でも **誰でもアクセスできます**。アプリ本体に個人データは含まれないので問題はありませんが、公開前の製品を見られたくない場合は B を選んでください。

### B. Cloudflare Pages (無料・非公開リポジトリ可)
1. Cloudflare にログイン → Workers & Pages → Create → Pages → **Connect to Git** でこのリポジトリを選ぶ
2. Build command: `npm run build` / Build output directory: `dist` / 環境変数 `NODE_VERSION` = `22`
3. 発行された `https://xxxx.pages.dev` を開く (push するたびに自動更新)

### C. 手元で手早く (アカウント登録が最少)
1. GitHub → Actions → CI の最新の実行 → **Artifacts の `familyhub-dist`** をダウンロードして展開
2. Netlify Drop (https://app.netlify.com/drop) にフォルダごとドラッグ → HTTPS の URL が発行される

## 2. スマートフォンでの準備

| | iPhone (iOS 16.4 以降) | Android (Chrome) |
|---|---|---|
| 開く | **Safari** で URL を開く (推奨) | Chrome で URL を開く |
| インストール | 共有ボタン → **ホーム画面に追加** | メニュー → **アプリをインストール** (またはホーム画面に追加) |
| 以降 | ホーム画面のアイコンから起動して確認 | 同左 |
| カメラ | 初回の QR 読み取り時に許可 | 同左 |

## 3. 同期を試すときの注意

- 2 台を **同じ Wi-Fi** (ゲスト Wi-Fi ではない) につなぐ。片方がモバイル回線だと接続できません。
- 両方の端末でアプリを開いたまま操作する (画面ロックすると切断されます)。
- iPhone ⇔ Android、iPhone ⇔ iPhone、Android ⇔ Android の 3 通りを試すのが理想です。
- うまくつながらない場合は、エラー画面の文言と、端末の機種・OS バージョン・Wi-Fi ルーターの機種を記録してください。

## 4. 確認項目

[testing.md §3 の実機検証チェックリスト](./testing.md#3-実機検証チェックリスト-リリース前に必須) を上から順に試し、結果 (○/×) を記録してください。

## 5. 更新の反映

新しいバージョンを公開すると、アプリ上部に「新しいバージョンがあります」と表示されます。「更新」を押すと反映されます (表示されない場合はアプリを一度閉じて開き直す)。
