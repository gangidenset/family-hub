# ストア公開の準備

## 1. 配布形態

| 形態 | 内容 | 状態 |
|---|---|---|
| Web (PWA) | `npm run build` の `dist/` を HTTPS の静的ホスティングに置く | ✅ ビルド可能 (サーバー設定不要: ハッシュルーティング・相対パス) |
| Android (Google Play) | Capacitor で `dist/` を同梱した有料アプリ | ⬜ 設定ファイルのみ用意 (`capacitor.config.json`)。ネイティブプロジェクトは未生成・未ビルド |
| iOS (App Store) | 同上 | ⬜ 同上 |

### PWA の公開 (例: GitHub Pages)
1. `npm ci && npm run build`
2. `dist/` を公開 (サブパスでも動作するよう `base: './'` にしてある)
3. `about.html` (紹介ページ)・`legal/*.html` も同時に公開される

> HTTPS が必須です (Service Worker・カメラ・Web Crypto・WebRTC の要件)。

### Capacitor でのネイティブ化手順 (未実施)
```bash
npm i @capacitor/core && npm i -D @capacitor/cli
npm i @capacitor/android @capacitor/ios
npm run build
npx cap add android && npx cap add ios
npx cap sync
npx cap open android   # Android Studio でビルド
npx cap open ios       # Xcode でビルド (macOS が必要)
```
追加で必要な設定:
- **iOS `Info.plist`**: `NSCameraUsageDescription` = 「家族の端末と接続するための QR コードを読み取ります。映像は保存・送信されません。」
- **Android**: `android.permission.CAMERA` (WebView の getUserMedia 用に `WebChromeClient.onPermissionRequest` の許可処理が必要)
- WebView 内の WebRTC は Android System WebView / WKWebView で動作するが、**実機検証が必要**
- 将来の LAN 自動発見 (Bonjour/NSD) を入れる場合: iOS `NSLocalNetworkUsageDescription` / `NSBonjourServices`

## 2. 価格

- 買い切り: 日本 600 円 (初期案。500〜800 円の範囲で検討) / 米国 $4.99
- ストアの「有料アプリ」として販売し、アプリ内課金・ライセンス確認コードは入れない (ADR-010)。購入後はオフラインで使い続けられる。

## 3. ストア掲載情報 (案)

**名前**: FamilyHub — 家族の共有リスト
**サブタイトル (30 字)**: サーバーに預けない家族の買い物・予定・タスク

**説明文**:
> 買い物リスト、家族の予定、家事の分担、大切なメモ。FamilyHub は、家族の「いつもの」を家族のスマホの中だけで共有するアプリです。
>
> ■ アカウント登録なし・サーバー保存なし
> データは家族の端末にだけ保存され、開発者を含む第三者に送られることはありません。広告や行動追跡もありません。
>
> ■ QR コードでつながる
> 家族の端末同士を QR コードでつなぎ、同じ Wi-Fi で直接同期。通信は暗号化されます。
>
> ■ オフラインで使える
> 電波の届かない場所でも、買い物リストを確認・チェックできます。
>
> ■ 主な機能
> ・買い物リスト (複数リスト / カテゴリー / 数量 / 購入履歴 / よく買う物)
> ・家族カレンダー (参加メンバー / カテゴリー)
> ・タスク (担当者 / 期限 / 未完了一覧)
> ・共有メモ (ピン留め / カテゴリー)
> ・バックアップと復元 (パスフレーズ暗号化)
> ・ダークモード / 文字サイズ調整
>
> ※ 同期には、両方の端末で同じ Wi-Fi に接続しアプリを開いている必要があります。ゲスト Wi-Fi など端末間通信が制限された環境では、暗号化ファイルによる同期をご利用ください。

**キーワード**: 家族, 共有, 買い物リスト, カレンダー, タスク, 家事分担, メモ, オフライン, プライバシー

## 4. プライバシー申告

| ストア | 申告内容 |
|---|---|
| App Store「App のプライバシー」 | **データの収集なし** (Data Not Collected) |
| Google Play「データ セーフティ」 | 収集するデータ: なし / 共有するデータ: なし / 転送時の暗号化: はい (端末間通信) / データ削除の手段: アプリ内「すべて削除」 |
| 年齢区分 | 全年齢 (ユーザー生成コンテンツの外部公開なし) |

プライバシーポリシー URL: `https://<公開先>/legal/privacy.html`

## 5. スクリーンショット (撮影予定)

1. ホーム (直近の予定・未完了タスク)
2. 買い物リスト (カテゴリー表示・購入済み)
3. カレンダー
4. QR でつながる画面 (確認コード)
5. 「データはあなたの端末にだけ」訴求画像
6. ダークモード

## 6. 審査メモ (App Review Notes 案)

> This app has no server and no account. To test syncing, install the app on two devices on the same Wi-Fi, create a group on one device, then choose "Members → Add device" and scan the QR codes in both directions. All data stays on the devices.

## 7. 公開前チェックリスト

- [ ] `public/legal/*.html` の [ ] 内 (運営者名・連絡先・管轄裁判所) を記入し、専門家の確認を受ける
- [ ] [testing.md](./testing.md) §3 の実機検証をすべて実施
- [ ] `package.json` / `src/backup/backup.ts` の `APP_VERSION` を更新
- [ ] アイコン (`public/icons/`) を最終デザインに差し替え (現在は仮デザイン)
- [ ] 本番配信の HTTP ヘッダーにも CSP を設定 (meta タグに加えて)
