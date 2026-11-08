import { useLiveQuery } from 'dexie-react-hooks';
import type { CategoryScope, Member, RecordMap, SharedTable } from '../domain/schemas';
import { getSettings, listActive, unsyncedCount } from '../db/repo';
import { useApp } from './context';
import { db as defaultDb } from '../db/instance';

/** 現在のグループの削除されていないレコードを購読 (他端末からの同期でも自動更新) */
export function useActive<T extends SharedTable>(table: T): RecordMap[T][] | undefined {
  const { db, session } = useApp();
  return useLiveQuery(() => listActive(db, session.groupId, table), [db, session.groupId, table]);
}

export function useMembers(): Member[] {
  return useActive('members') ?? [];
}

export function useMemberMap(): Map<string, Member> {
  const members = useMembers();
  return new Map(members.map((m) => [m.id, m]));
}

export function useCategories(scope: CategoryScope) {
  const cats = useActive('categories');
  return (cats ?? []).filter((c) => c.scope === scope).sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1));
}

export function useSettings() {
  return useLiveQuery(() => getSettings(defaultDb), []);
}

export function useSyncSummary() {
  const { db, session } = useApp();
  return useLiveQuery(async () => {
    const peers = await db.peers.where('[groupId+deviceId]').between([session.groupId, ''], [session.groupId, '￿']).toArray();
    const last = peers.filter((p) => p.lastSyncAt).sort((a, b) => (a.lastSyncAt! < b.lastSyncAt! ? 1 : -1))[0];
    const devices = await listActive(db, session.groupId, 'devices');
    return {
      pending: await unsyncedCount(db, session),
      lastSyncAt: last?.lastSyncAt ?? null,
      lastPeerName: last ? (devices.find((d) => d.id === last.deviceId)?.name ?? null) : null,
      otherDevices: devices.filter((d) => d.id !== session.deviceId && !d.revoked).length,
    };
  }, [db, session.groupId, session.deviceId]);
}
