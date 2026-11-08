# 04. データベース設計

保存先は IndexedDB（Dexie.js）。スキーマは Dexie のバージョン機構で管理し、アップグレード関数でマイグレーションします。

## 1. 設計方針

1. **全レコードがグループに属する**: `groupId` を全共有エンティティに持たせ、インデックスの先頭キーにする → グループ単位のデータ分離・削除・エクスポートが確実になる。
2. **物理削除しない（トゥームストーン）**: 削除は `deleted: true` を立てる。同期相手に「削除された」ことを伝えるため。90 日経過かつ全既知端末と同期済みのものは後で圧縮（Phase 4 で検討）。
3. **フィールド単位の更新時刻**: 各レコードに `clock: { [field]: HLC }` を持たせ、フィールド単位で Last-Writer-Wins 判定する。
4. **操作ログ（oplog）**: すべての変更を `(deviceId, seq)` で採番して記録。同期時はバージョンベクタで差分だけ送る。
5. **ID は端末で生成**: `crypto.randomUUID()`。衝突確率は実用上ゼロ、オフライン作成可能。
6. **日時**: 時刻は ISO 8601（UTC, `2026-11-08T03:00:00.000Z`）、終日予定・期限日は `YYYY-MM-DD`（タイムゾーンに依存しない日付）。
7. **厳格なスキーマ**: 未知のフィールドは拒否する。互換性はスキーマ/プロトコルのバージョンで管理する（ADR-015 で当初案から変更）。
8. **変更されたフィールドだけを記録**: 同じ値の再保存は操作ログに残さない（ADR-016）。

## 2. HLC（Hybrid Logical Clock）

端末の時計がずれていても因果順序を保つための時刻表現。

```
HLC 文字列 = <物理時刻ms 13桁ゼロ埋め>-<カウンタ 4桁16進>-<deviceId>
例: 1762570800000-0003-5c1e...  ← 文字列比較で大小が決まる
```

- ローカル変更時: `max(現在時刻, 直前 HLC の時刻)` を使い、同じならカウンタ +1。
- 受信時: 相手の HLC を取り込んで自分の時計を進める。
- 端末時計が大きく未来にずれた HLC（現在 + 24h 超）は受信時に拒否し、ユーザーに時計設定の確認を促す（1 台の誤設定で全データが「上書き不能」になることを防ぐ）。

## 3. 共通フィールド

```ts
interface SyncedRecord {
  id: string;            // UUID
  groupId: string;       // 所属家族グループ
  createdAt: string;     // ISO
  createdBy: string;     // memberId
  updatedAt: string;     // 表示用 (最終更新)
  updatedBy: string;     // memberId
  deleted: boolean;      // トゥームストーン
  clock: Record<string, string>; // フィールド名 → HLC
}
```

## 4. ストア一覧

### ローカル専用（同期しない）

| ストア | キー | 主なフィールド | 説明 |
|---|---|---|---|
| `meta` | `key` | `value` | `schemaVersion`, `deviceId`, `currentGroupId`, `hlcLast`, 表示設定 |
| `groupKeys` | `[groupId+epoch]` | `key` (raw 32 byte) | グループ鍵。メンバー削除時に epoch を進めて鍵更新 |
| `peers` | `[groupId+deviceId]` | `name`, `memberId`, `lastSyncAt`, `lastResult`, `vector` | 同期相手ごとの状態（最後に受け取ったベクタ、成功/失敗） |
| `oplog` | `[groupId+deviceId+seq]` | `hlc`, `table`, `recordId`, `patch` | 変更ログ。自端末分と受信分の両方を保持 |
| `conflicts` | `id` | `table`, `recordId`, `field`, `losingValue`, `losingHlc`, `resolvedAt` | 長文フィールドで上書きされた側の値を保存（ユーザーが確認・復元できる） |

### 共有（同期対象）— すべて `SyncedRecord` を継承

| ストア | インデックス | 固有フィールド |
|---|---|---|
| `groups` | `id` | `name` |
| `members` | `[groupId+deleted]` | `name`, `color`, `icon`, `role: 'adult' \| 'child'` |
| `devices` | `[groupId+memberId]` | `name`（例: 「母の iPhone」）, `memberId`, `revoked` |
| `categories` | `[groupId+scope]` | `scope: 'shopping' \| 'memo' \| 'event' \| 'task'`, `name`, `color`, `sortKey` |
| `shoppingLists` | `[groupId+deleted]` | `name`, `sortKey` |
| `shoppingItems` | `[groupId+listId]`, `[groupId+checked]` | `listId`, `name`, `quantity`, `unit`, `categoryId`, `note`, `checked`, `checkedAt`, `checkedBy`, `sortKey` |
| `purchases` | `[groupId+purchasedAt]` | `itemId`, `name`, `quantity`, `unit`, `categoryId`, `listId`, `purchasedAt`, `purchasedBy` — 購入済みにした時点で追記（追記専用）。履歴表示と「よく買う物」候補に使う |
| `memos` | `[groupId+pinned]`, `[groupId+updatedAt]` | `title`, `body`, `categoryId`, `pinned` |
| `events` | `[groupId+startDate]` | `title`, `allDay`, `start`（ISO or 日付）, `end`, `startDate`（検索用 `YYYY-MM-DD`）, `memberIds[]`, `categoryId`, `location`, `note` |
| `tasks` | `[groupId+done]`, `[groupId+dueDate]`, `[groupId+assigneeId]` | `title`, `assigneeId`, `dueDate`, `done`, `doneAt`, `doneBy`, `categoryId`, `note` |

**並び順 `sortKey`**: 分数インデックス（fractional indexing, 文字列）。2 つの項目の間に挿入しても他の項目を書き換えないため、並び替えが同期で競合しにくい。

## 5. 操作ログとバージョンベクタ

```ts
interface OpLogEntry {
  groupId: string;
  deviceId: string;     // 変更を行った端末
  seq: number;          // 端末ごとの連番 (1, 2, 3, ...)
  hlc: string;
  table: SharedTable;
  recordId: string;
  patch: Record<string, unknown>; // 変更されたフィールドのみ
}
type VersionVector = Record<string /* deviceId */, number /* 受信済み最大 seq */>;
```

- 変更 1 回 = レコード更新 + oplog 追記 を **同一トランザクション** で行う（片方だけ残る不整合を防ぐ）。
- 同期: 相手のベクタを受け取り、`seq > vector[deviceId]` のログだけ送る。受信側は適用後に自分のベクタを進める。
- ログは冪等: 同じログを 2 回受け取っても結果は変わらない → 途中で切断しても再送で安全に再開できる。

## 6. マージ規則

| 状況 | 規則 |
|---|---|
| 同一フィールドを両端末で変更 | HLC が大きい方を採用（LWW）。HLC は deviceId を含むため必ず全端末で同じ結果に収束 |
| 別フィールドを変更（例: A が数量、B がメモ） | 両方とも反映される（フィールド単位のため） |
| 削除 vs 編集 | 削除（`deleted`）もフィールドとして LWW。ただし削除後の編集が後勝ちした場合は「復活」する。UI で「別の家族が編集したため復元されました」と表示 |
| メモ本文・タイトルの同時編集 | LWW で一方を採用し、負けた側の値を `conflicts` に保存。メモ画面に「競合した編集があります」バッジ → ユーザーが内容を確認して選択/統合できる |
| 購入済みチェックの同時操作 | `checked` の LWW。購入履歴 `purchases` は追記専用なので重複がありうる → 同一品目・同一リストで 1 分以内の重複は表示時に集約 |

## 7. バックアップ形式

```jsonc
{
  "format": "familyhub-backup",
  "formatVersion": 1,          // データ形式バージョン (互換性判定)
  "appVersion": "1.0.0",
  "exportedAt": "2026-11-08T03:00:00.000Z",
  "schemaVersion": 1,          // DB スキーマバージョン
  "group": { "id": "...", "name": "..." },
  "data": {                    // 共有ストアの全レコード (トゥームストーン含む)
    "members": [], "devices": [], "categories": [],
    "shoppingLists": [], "shoppingItems": [], "purchases": [],
    "memos": [], "events": [], "tasks": []
  },
  "sync": { "keys": [...], "vector": {...} },  // 暗号化バックアップ時のみ含める (後述)
  "checksum": "sha256:..."     // data の正規化 JSON のハッシュ (破損検知)
}
```

- `formatVersion` が自アプリより新しい場合は復元を拒否し「アプリを更新してください」と表示。古い場合はマイグレーション関数で変換。
- グループ鍵は機微情報のため、**通常の JSON バックアップには含めない**。鍵を含めたい場合はパスフレーズで暗号化した「完全バックアップ」として出力（PBKDF2 → AES-GCM）。鍵がない状態で復元した端末は、家族の端末と再ペアリングすれば同期を再開できる。
- 復元はすべて zod で検証 → 件数・内容のプレビュー確認画面 → 既存データを置換（またはマージ）の順。詳細は [07-security](./07-security.md)。

## 8. 実装との対応

- スキーマ定義: `src/domain/schemas.ts`（zod）/ `src/db/db.ts`（Dexie）
- 書き込み・操作ログ: `src/db/repo.ts`、マージ: `src/sync/merge.ts`、バックアップ: `src/backup/backup.ts`
- 復元時は端末 ID を再発行する（ADR-017）

## 9. マイグレーション方針

- Dexie の `db.version(n).stores(...).upgrade(tx => ...)` で段階的に移行。バージョンを飛ばした更新でも順に適用される。
- 同期プロトコルにも `protocolVersion` を持たせ、異なるバージョンの端末同士は互換範囲内でのみ同期（非互換なら「アプリを更新してください」）。
