# FamilyHub

**オフラインで使える・データを外に出さない、家族のための共有アプリ。**

買い物リスト・共有メモ・家族の予定・タスクを、サーバーやアカウントなしで家族のスマートフォン間で共有します。

- 📴 インターネットなしで全機能が動作（PWA / 端末内保存）
- 🔒 データは家族の端末にだけ保存。外部サーバー・解析・広告なし
- 👨‍👩‍👧 QR コードで家族の端末をつなぎ、同じ Wi-Fi で直接同期（暗号化）
- 💴 買い切り型（予定）

> **現在の状態: Phase 1（設計・技術検証）完了。アプリ本体は未実装です。**
> 進捗と検証結果は [Phase 1 完了報告](docs/phase1-report.md) を参照してください。

## ドキュメント

| 文書 | 内容 |
|---|---|
| [要件整理](docs/01-requirements.md) | 機能・非機能要件、制約 |
| [技術選定](docs/02-tech-stack.md) | 採用技術とその理由 |
| [システム構成](docs/03-architecture.md) | 構成図・レイヤー・ディレクトリ |
| [データベース設計](docs/04-data-model.md) | IndexedDB スキーマ・同期用メタデータ・バックアップ形式 |
| [画面設計](docs/05-screens.md) | 7 画面とデザイントークン |
| [同期方式](docs/06-sync-design.md) | サーバーなし端末間通信の検証結果と方式 |
| [セキュリティ](docs/07-security.md) | 脅威モデルと設計判断 |
| [判断ログ](docs/decisions.md) | ADR |

## 技術スタック（予定）

TypeScript / React / Vite / vite-plugin-pwa / Dexie.js (IndexedDB) / WebRTC DataChannel / Web Crypto API / zod — 将来 Capacitor で Android・iOS アプリ化。

## 技術検証コードの実行

前提: Node.js 20 以上、Playwright と Chromium がインストール済みであること。

```bash
cd spikes/webrtc-qr
npm install
npm test   # 2 つのブラウザ間でサーバーなし WebRTC 接続を検証し、結果 JSON を出力
```

アプリ本体の環境構築・実行方法は Phase 2 で追記します。

## ライセンス

未定（製品として販売予定のため、現時点では All rights reserved）。
