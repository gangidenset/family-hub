// Repository 層: UI からの書き込みはすべてここを通す。
// 変更 1 回 = レコード更新 + 操作ログ追記 を同一トランザクションで行う (docs/04-data-model.md §5)
import {
  CONFLICT_FIELDS,
  patchSchemas,
  type Fields,
  type Op,
  type RecordMap,
  type SharedTable,
} from '../domain/schemas';
import { toB64url, randomBytes } from '../lib/bytes';
import type { DeviceMeta, FamilyDB, GroupKey, SessionMeta, SettingsMeta } from './db';
import { tick } from './hlc';

export interface Session {
  groupId: string;
  memberId: string;
  deviceId: string;
}

export class NotFoundError extends Error {}

export async function ensureDevice(db: FamilyDB): Promise<DeviceMeta> {
  return db.transaction('rw', db.meta, async () => {
    const existing = (await db.meta.get('device')) as DeviceMeta | undefined;
    if (existing) return existing;
    const device: DeviceMeta = { key: 'device', deviceId: crypto.randomUUID(), seq: 0, hlc: { ms: 0, counter: 0 } };
    await db.meta.put(device);
    return device;
  });
}

export async function getSession(db: FamilyDB): Promise<Session | null> {
  const device = await ensureDevice(db);
  const s = (await db.meta.get('session')) as SessionMeta | undefined;
  return s ? { groupId: s.groupId, memberId: s.memberId, deviceId: device.deviceId } : null;
}

export async function setSession(db: FamilyDB, groupId: string, memberId: string): Promise<void> {
  await db.meta.put({ key: 'session', groupId, memberId });
}

export const DEFAULT_SETTINGS: SettingsMeta = { key: 'settings', theme: 'system', fontScale: 'normal', lastBackupAt: null };

export async function getSettings(db: FamilyDB): Promise<SettingsMeta> {
  return ((await db.meta.get('settings')) as SettingsMeta | undefined) ?? DEFAULT_SETTINGS;
}

export async function updateSettings(db: FamilyDB, patch: Partial<Omit<SettingsMeta, 'key'>>): Promise<void> {
  await db.transaction('rw', db.meta, async () => {
    await db.meta.put({ ...(await getSettings(db)), ...patch, key: 'settings' });
  });
}

type WritePatch<T extends SharedTable> = Partial<Fields<T>> & { deleted?: boolean };

/**
 * レコードを作成/更新し、操作ログを追記する。
 * 戻り値はレコード ID。
 */
export async function write<T extends SharedTable>(
  db: FamilyDB,
  session: Session,
  table: T,
  id: string,
  patch: WritePatch<T>,
  mode: 'create' | 'update',
): Promise<string> {
  const tbl = db.shared(table);
  await db.transaction('rw', [tbl, db.oplog, db.meta], async () => {
    const device = (await db.meta.get('device')) as DeviceMeta | undefined;
    if (!device || device.deviceId !== session.deviceId) throw new Error('device not initialized');
    const existing = (await tbl.get(id)) as RecordMap[T] | undefined;
    if (mode === 'update' && (!existing || existing.groupId !== session.groupId)) throw new NotFoundError(table);
    if (mode === 'create' && existing) throw new Error('duplicate id');

    const nowIso = new Date().toISOString();
    const full: Record<string, unknown> = { ...patch, updatedAt: nowIso, updatedBy: session.memberId };
    if (mode === 'create') {
      Object.assign(full, { groupId: session.groupId, createdAt: nowIso, createdBy: session.memberId, deleted: false, ...patch });
    }
    // 入力値検証 (UI 側のバグや改ざんがあっても不正値を保存しない)
    const validPatch = patchSchemas[table].parse(full) as Record<string, unknown>;

    const { state, hlc } = tick(device.hlc, Date.now(), device.deviceId);
    const seq = device.seq + 1;

    const conflictFields: readonly string[] = CONFLICT_FIELDS[table] ?? [];
    const base: Record<string, string | null> = {};
    for (const f of conflictFields) {
      if (f in validPatch) base[f] = (existing?.clock as Record<string, string> | undefined)?.[f] ?? null;
    }

    const clock: Record<string, string> = { ...(existing?.clock ?? {}) };
    for (const k of Object.keys(validPatch)) clock[k] = hlc;
    const record = { ...(existing ?? { id }), ...validPatch, clock } as RecordMap[T];
    await tbl.put(record);

    // 圧縮: 自端末の過去の操作から、今回上書きしたフィールドを取り除く (競合検出用フィールドは残す)
    const prev = await db.oplog
      .where('[groupId+recordId]')
      .equals([session.groupId, id])
      .filter((o) => o.deviceId === device.deviceId)
      .toArray();
    for (const o of prev) {
      const stripped = Object.fromEntries(
        Object.entries(o.patch).filter(([k]) => !(k in validPatch) || conflictFields.includes(k)),
      );
      if (Object.keys(stripped).length !== Object.keys(o.patch).length) {
        await db.oplog.put({ ...o, patch: stripped });
      }
    }

    const op: Op = { groupId: session.groupId, deviceId: device.deviceId, seq, hlc, table, recordId: id, patch: validPatch };
    if (Object.keys(base).length) op.base = base;
    await db.oplog.add(op);
    await db.meta.put({ ...device, seq, hlc: state });
  });
  return id;
}

export function create<T extends SharedTable>(db: FamilyDB, session: Session, table: T, fields: Fields<T>, id: string = crypto.randomUUID()) {
  return write(db, session, table, id, fields as WritePatch<T>, 'create');
}

export function update<T extends SharedTable>(db: FamilyDB, session: Session, table: T, id: string, patch: Partial<Fields<T>>) {
  return write(db, session, table, id, patch as WritePatch<T>, 'update');
}

export function softDelete<T extends SharedTable>(db: FamilyDB, session: Session, table: T, id: string) {
  return write(db, session, table, id, { deleted: true } as WritePatch<T>, 'update');
}

export function restoreDeleted<T extends SharedTable>(db: FamilyDB, session: Session, table: T, id: string) {
  return write(db, session, table, id, { deleted: false } as WritePatch<T>, 'update');
}

/** グループの全レコード (削除済みを除く) */
export async function listActive<T extends SharedTable>(db: FamilyDB, groupId: string, table: T): Promise<RecordMap[T][]> {
  const rows = (await db.shared(table).where('groupId').equals(groupId).toArray()) as RecordMap[T][];
  return rows.filter((r) => !r.deleted);
}

/** 操作ログから現在のバージョンベクタを算出 */
export async function getVector(db: FamilyDB, groupId: string): Promise<Record<string, number>> {
  const keys = await db.oplog
    .where('[groupId+deviceId+seq]')
    .between([groupId, '', 0], [groupId, '\uffff', Infinity])
    .primaryKeys();
  const v: Record<string, number> = {};
  for (const [, d, s] of keys) if ((v[d] ?? 0) < s) v[d] = s;
  return v;
}

/** 相手のベクタに含まれない操作 (デバイスごとに seq 昇順) */
export async function opsSince(db: FamilyDB, groupId: string, peerVector: Record<string, number>): Promise<Op[]> {
  const mine = await getVector(db, groupId);
  const out: Op[] = [];
  for (const [d, max] of Object.entries(mine)) {
    const from = (peerVector[d] ?? 0) + 1;
    if (from > max) continue;
    out.push(...(await db.oplog.where('[groupId+deviceId+seq]').between([groupId, d, from], [groupId, d, Infinity], true, true).toArray()));
  }
  return out;
}

// ---- グループ鍵 ----

export async function latestKey(db: FamilyDB, groupId: string): Promise<GroupKey | undefined> {
  const keys = await db.groupKeys.where('[groupId+epoch]').between([groupId, 0], [groupId, Infinity]).toArray();
  return keys.sort((a, b) => b.epoch - a.epoch)[0];
}

export async function addGroupKey(db: FamilyDB, groupId: string, epoch: number, key = toB64url(randomBytes(32))): Promise<GroupKey> {
  const gk: GroupKey = { groupId, epoch, key, createdAt: new Date().toISOString() };
  await db.groupKeys.put(gk);
  return gk;
}

/** 端末失効時の鍵更新: 新しい epoch の鍵を生成する */
export async function rotateKey(db: FamilyDB, groupId: string): Promise<GroupKey> {
  const cur = await latestKey(db, groupId);
  return addGroupKey(db, groupId, (cur?.epoch ?? 0) + 1);
}

/** 未送信の自端末の変更件数 (どの家族端末にもまだ渡っていない操作) */
export async function unsyncedCount(db: FamilyDB, session: Session): Promise<number> {
  const device = (await db.meta.get('device')) as DeviceMeta | undefined;
  if (!device) return 0;
  const peers = await db.peers.where('[groupId+deviceId]').between([session.groupId, ''], [session.groupId, '\uffff']).toArray();
  const acked = Math.max(0, ...peers.map((p) => p.vector[session.deviceId] ?? 0));
  const ownMax = (await getVector(db, session.groupId))[session.deviceId] ?? 0;
  return Math.max(0, ownMax - acked);
}
