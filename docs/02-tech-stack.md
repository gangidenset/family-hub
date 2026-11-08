# 02. 技術選定

## 結論

| 領域 | 採用技術 | 主な理由 |
|---|---|---|
| 言語 | **TypeScript (strict)** | 型安全性。データモデル・同期プロトコルの型を UI からストレージまで共有できる |
| UI | **React 19** | エコシステム・保守人材の多さ、長期保守性。Capacitor との実績も豊富 |
| ビルド | **Vite** | 高速な開発サーバー、PWA プラグインとの統合 |
| PWA | **vite-plugin-pwa (Workbox, injectManifest)** | 全アセットのプリキャッシュ、更新フロー制御。独自 SW コードを書ける方式を選択 |
| ローカル DB | **Dexie.js 4 (IndexedDB)** | スキーマバージョン管理とマイグレーション、インデックス、トランザクション、`liveQuery` による UI 自動更新 |
| ルーティング | React Router（ハッシュ不要の History API） | 標準的。PWA のディープリンク |
| スタイル | CSS Modules + CSS カスタムプロパティ（デザイントークン） | 依存を増やさず、ライト/ダークをトークン切替で実現。UI ライブラリは使わない（サイズ・デザイン統制のため） |
| 入力検証 | **zod** | バックアップ・同期で受け取る外部データを実行時に厳格検証し、型も導出できる |
| 暗号 | **Web Crypto API**（標準） | AES-GCM / HKDF / HMAC / ECDH。外部暗号ライブラリ不要、ネイティブ実装で高速 |
| P2P 通信 | **WebRTC DataChannel**（STUN/TURN なし） | ブラウザ標準で唯一の端末間直接通信手段。DTLS で暗号化済み |
| QR 生成 | `qrcode` | 実績あり。Spike で検証済み |
| QR 読み取り | `BarcodeDetector`（Android Chrome）→ 非対応環境は `jsQR` | iOS Safari は BarcodeDetector 非対応のため JS 実装を併用。Spike でデコード検証済み。実機で読み取り性能が不足する場合は `zxing-wasm` に切替 |
| 日付 | `date-fns` | ツリーシェイク可能、タイムゾーンを壊さない |
| テスト | Vitest + fake-indexeddb（単体）/ Playwright（E2E・オフライン・2 端末同期） | Playwright で複数ブラウザ間の WebRTC 同期を自動テストできることを Spike で確認済み |
| 品質 | ESLint + Prettier | |
| ネイティブ化（将来） | **Capacitor** | 同じ Web コードを Android/iOS アプリとしてストア配布。ネイティブプラグインで LAN 自動検出（Bonjour/NSD）や TCP 通信が可能になり、PWA の同期制約を解消できる |

## 検討した代替案

### UI フレームワーク / アプリ方式

| 候補 | 評価 | 不採用理由 |
|---|---|---|
| **React + Capacitor (採用)** | PWA 必須要件を満たしつつ、そのままストアアプリ化できる | — |
| Flutter | 高品質なネイティブ UI | Web (PWA) 出力はサイズが大きく初回読み込みが重い。Service Worker 制御も弱い |
| React Native (+ Expo Web) | ネイティブ品質 | Web 版は二級市民。IndexedDB/WebRTC などの Web 標準と二重実装になる |
| Svelte / Solid | バンドルが小さい | 性能差はこの規模では体感差が小さく、長期保守・人材面で React を優先 |

### ローカル DB

| 候補 | 不採用理由 |
|---|---|
| 素の IndexedDB | マイグレーション・クエリを自前実装する必要があり、バグの温床 |
| SQLite (wasm, OPFS) | iOS Safari での OPFS 同期アクセスの安定性に懸念。バンドル増。ネイティブ化時に再検討 |
| RxDB / PouchDB | 同期機能はサーバー前提（CouchDB 等）で本アプリの P2P 方式に合わない。サイズ大 |

### 競合解決

| 候補 | 評価 |
|---|---|
| **フィールド単位 LWW + HLC + 操作ログ (採用)** | 家族アプリの編集粒度（買い物項目・タスク等の小さなレコード）に十分。実装が透明で検証しやすい。データ形式を自前で管理でき、バックアップ形式と統一できる |
| Automerge / Yjs (CRDT) | テキスト同時編集まで綺麗に統合できるが、wasm/ライブラリ依存とデータ形式のブラックボックス化。長文メモの同時編集は頻度が低いため初期版では「競合コピー保持」で対応し、必要なら後で Yjs をメモ本文に限定導入する |

### 端末間通信

[06-sync-design.md](./06-sync-design.md) で詳述。

## バージョン方針

- 依存は `package-lock.json` で固定し、Dependabot 等で定期更新。
- 実行時依存は最小限に保つ（目標: React, React Router, Dexie, zod, qrcode, jsQR, date-fns 程度）。依存が少ないほどサプライチェーンリスクが減る。
