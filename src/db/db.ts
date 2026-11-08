// IndexedDB スキーマ (docs/04-data-model.md)
import Dexie, { type Table } from 'dexie';
import type { Op, RecordMap, SharedTable } from '../domain/schemas';
import type { HlcState } from './hlc';

export const SCHEMA_VERSION = 1;

export interface DeviceMeta {
  key: 'device';
  deviceId: string;
  /** 自端末の操作ログ連番 (最後に採番した値) */
  seq: number;
  hlc: HlcState;
}
export interface SessionMeta {
  key: 'session';
  groupId: string;
  memberId: string;
}
export type ThemeSetting = 'system' | 'light' | 'dark';
export type FontScale = 'normal' | 'large' | 'xlarge';
export interface SettingsMeta {
  key: 'settings';
  theme: ThemeSetting;
  fontScale: FontScale;
  lastBackupAt: string | null;
}
export type MetaRow = DeviceMeta | SessionMeta | SettingsMeta;

export interface GroupKey {
  groupId: string;
  epoch: number;
  /** 32 byte の乱数鍵 (base64url) */
  key: string;
  createdAt: string;
}

export type SyncErrorCode =
  | 'connect-timeout'
  | 'connection-lost'
  | 'auth-failed'
  | 'different-group'
  | 'revoked'
  | 'incompatible-version'
  | 'invalid-data'
  | 'missing-key'
  | 'clock-drift'
  | 'cancelled'
  | 'unknown';

export interface Peer {
  groupId: string;
  deviceId: string;
  lastSyncAt: string | null;
  lastAttemptAt: string;
  lastResult: 'ok' | 'error';
  lastError: SyncErrorCode | null;
  via: 'webrtc' | 'file';
  /** 相手が保持していると分かっているバージョンベクタ */
  vector: Record<string, number>;
}

export interface Conflict {
  id: string;
  groupId: string;
  table: SharedTable;
  recordId: string;
  field: string;
  /** 採用されなかった側の値 */
  losingValue: unknown;
  losingHlc: string;
  detectedAt: string;
  resolved: boolean;
}

export type SharedTables = { [K in SharedTable]: Table<RecordMap[K], string> };

export class FamilyDB extends Dexie {
  meta!: Table<MetaRow, string>;
  groupKeys!: Table<GroupKey, [string, number]>;
  peers!: Table<Peer, [string, string]>;
  oplog!: Table<Op, [string, string, number]>;
  conflicts!: Table<Conflict, string>;
  groups!: Table<RecordMap['groups'], string>;
  members!: Table<RecordMap['members'], string>;
  devices!: Table<RecordMap['devices'], string>;
  categories!: Table<RecordMap['categories'], string>;
  shoppingLists!: Table<RecordMap['shoppingLists'], string>;
  shoppingItems!: Table<RecordMap['shoppingItems'], string>;
  purchases!: Table<RecordMap['purchases'], string>;
  memos!: Table<RecordMap['memos'], string>;
  events!: Table<RecordMap['events'], string>;
  tasks!: Table<RecordMap['tasks'], string>;

  constructor(name = 'familyhub') {
    super(name);
    // boolean は IndexedDB でインデックスできないため、絞り込みはメモリ上で行う (家族規模では十分高速)
    this.version(SCHEMA_VERSION).stores({
      meta: 'key',
      groupKeys: '[groupId+epoch]',
      peers: '[groupId+deviceId]',
      oplog: '[groupId+deviceId+seq], [groupId+recordId]',
      conflicts: 'id, [groupId+table+recordId]',
      groups: 'id, groupId',
      members: 'id, groupId',
      devices: 'id, groupId',
      categories: 'id, groupId',
      shoppingLists: 'id, groupId',
      shoppingItems: 'id, groupId, [groupId+listId]',
      purchases: 'id, groupId, [groupId+purchasedAt]',
      memos: 'id, groupId',
      events: 'id, groupId, [groupId+startDate]',
      tasks: 'id, groupId',
    });
  }

  shared<T extends SharedTable>(t: T): Table<RecordMap[T], string> {
    return this.table(t) as Table<RecordMap[T], string>;
  }
}
