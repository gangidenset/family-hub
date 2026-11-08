# Phase 1 完了報告（設計・技術検証）

日付: 2026-11-08

## 実装・作成したもの

| 成果物 | 内容 |
|---|---|
| [01-requirements](./01-requirements.md) | 要件整理・スコープ・非機能要件・制約・未確定事項 |
| [02-tech-stack](./02-tech-stack.md) | 採用技術と理由、代替案の比較 |
| [03-architecture](./03-architecture.md) | システム構成図・レイヤー構成・ディレクトリ構成・PWA 設計 |
| [04-data-model](./04-data-model.md) | IndexedDB スキーマ、HLC、操作ログ、マージ規則、バックアップ形式 |
| [05-screens](./05-screens.md) | 7 画面の設計、ナビゲーション、同期 UI、デザイントークン |
| [06-sync-design](./06-sync-design.md) | サーバーなし端末間通信の方式比較・検証結果・ペアリング/同期手順・代替手段 |
| [07-security](./07-security.md) | 脅威モデルとセキュリティ設計判断 |
| [decisions](./decisions.md) | 技術判断ログ（ADR） |
| [`spikes/webrtc-qr`](../spikes/webrtc-qr/) | WebRTC + QR 手動シグナリングの動作検証コード |

## テスト結果（実際に実行したもののみ）

| テスト | 環境 | 結果 |
|---|---|---|
| STUN/TURN なしで WebRTC DataChannel 接続（mDNS 候補） | Chromium 1243 ×2 プロセス, 同一 Linux マシン | ✅ 成功・双方向通信 |
| 同上（生 IP 候補） | 同上 | ✅ 成功 |
| SDP 圧縮 → QR v9 以下に収まるか | 同上 | ✅ Offer 196 文字(v9) / Answer 116 文字(v7) |
| QR 生成 → デコード往復 | Node (qrcode → jsQR) | ✅ 一致 |
| DTLS フィンガープリント改ざん時に接続拒否 | Chromium ×2 | ✅ 接続失敗（期待どおり） |
| 不正な接続コード（3 種）の拒否 | Chromium | ✅ すべて拒否 |

**未実施（実機が必要なため、この開発環境では実行していません）**: Android/iPhone 実機、実際の家庭用 Wi-Fi、iOS Safari/WebKit、ホーム画面 PWA でのカメラ読み取り。これらは [06-sync-design §3](./06-sync-design.md) の V-1〜V-6 として Phase 3〜4 で検証します。

## 残課題・リスク

1. **最大のリスク: 家庭用 Wi-Fi での mDNS 解決（V-2）と iOS⇔Android 互換（V-1）**。Phase 3 冒頭で、Spike を実機で開けるテストページとして公開（HTTPS 必須）し、実機確認をお願いする必要があります。
2. PWA 版では同期のたびに QR を 2 回読む必要がある。UX 上の負担は Capacitor ネイティブ版の自動発見で解消予定。
3. PWA 版の販売形態（無料公開か否か）は未確定（実装には影響なし）。
4. 予定の繰り返し・通知は初期スコープ外。

## 次の Phase 2 の計画

1. Vite + React + TS プロジェクト構築、ESLint/Prettier/Vitest/Playwright 設定
2. デザイントークン・共通コンポーネント・下部タブレイアウト・ライト/ダーク
3. Dexie スキーマ v1・Repository 層・HLC・操作ログ（単体テスト付き）
4. 買い物リスト → タスク → メモ → 予定 → ホーム の順に実装
5. PWA 化（Service Worker・manifest）と Playwright によるオフライン起動テスト
