// 家族グループの作成・参加・削除
import type { CategoryScope, Color } from '../domain/schemas';
import { SHARED_TABLES } from '../domain/schemas';
import { keyBetween } from '../lib/sortkey';
import type { FamilyDB } from './db';
import { addGroupKey, create, ensureDevice, setSession, type Session } from './repo';

const DEFAULT_CATEGORIES: Record<CategoryScope, [string, Color][]> = {
  shopping: [
    ['野菜・果物', 'green'],
    ['肉・魚', 'red'],
    ['乳製品・卵', 'amber'],
    ['パン・主食', 'orange'],
    ['飲み物', 'blue'],
    ['日用品', 'purple'],
    ['その他', 'gray'],
  ],
  memo: [
    ['学校', 'blue'],
    ['家事', 'green'],
    ['連絡', 'orange'],
    ['その他', 'gray'],
  ],
  event: [
    ['家族', 'teal'],
    ['学校', 'blue'],
    ['仕事', 'indigo'],
    ['病院', 'red'],
    ['その他', 'gray'],
  ],
  task: [
    ['家事', 'green'],
    ['買い物', 'orange'],
    ['手続き', 'indigo'],
    ['その他', 'gray'],
  ],
};

export interface CreateGroupInput {
  groupName: string;
  memberName: string;
  memberColor: Color;
  deviceName: string;
}

export async function createGroup(db: FamilyDB, input: CreateGroupInput): Promise<Session> {
  const device = await ensureDevice(db);
  const session: Session = { groupId: crypto.randomUUID(), memberId: crypto.randomUUID(), deviceId: device.deviceId };
  await create(db, session, 'groups', { name: input.groupName }, session.groupId);
  await create(db, session, 'members', { name: input.memberName, color: input.memberColor, role: 'adult' }, session.memberId);
  await create(db, session, 'devices', { name: input.deviceName, memberId: session.memberId, revoked: false }, session.deviceId);
  for (const [scope, cats] of Object.entries(DEFAULT_CATEGORIES) as [CategoryScope, [string, Color][]][]) {
    let key: string | null = null;
    for (const [name, color] of cats) {
      key = keyBetween(key, null);
      await create(db, session, 'categories', { scope, name, color, sortKey: key });
    }
  }
  await create(db, session, 'shoppingLists', { name: 'いつもの買い物', sortKey: keyBetween(null, null) });
  await addGroupKey(db, session.groupId, 1);
  await setSession(db, session.groupId, session.memberId);
  return session;
}

/** 指定グループのデータをすべて端末から削除する (グループ単位のデータ分離) */
export async function deleteGroupData(db: FamilyDB, groupId: string): Promise<void> {
  const tables = [...SHARED_TABLES.map((t) => db.shared(t)), db.oplog, db.groupKeys, db.peers, db.conflicts, db.meta];
  await db.transaction('rw', tables, async () => {
    for (const t of SHARED_TABLES) {
      if (t === 'groups') await db.groups.delete(groupId);
      else await db.shared(t).where('groupId').equals(groupId).delete();
    }
    await db.oplog.where('[groupId+deviceId+seq]').between([groupId, '', 0], [groupId, '￿', Infinity]).delete();
    await db.groupKeys.where('[groupId+epoch]').between([groupId, 0], [groupId, Infinity]).delete();
    await db.peers.where('[groupId+deviceId]').between([groupId, ''], [groupId, '￿']).delete();
    await db.conflicts.filter((c) => c.groupId === groupId).delete();
    const s = await db.meta.get('session');
    if (s && 'groupId' in s && s.groupId === groupId) await db.meta.delete('session');
  });
}

/** 端末内の全データを削除する (deviceId も再生成される) */
export async function wipeAll(db: FamilyDB): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
}
