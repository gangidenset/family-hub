import { describe, expect, it } from 'vitest';
import { memoryPair } from '../../src/sync/channel';
import { runSync, SyncError } from '../../src/sync/protocol';
import { runPairInviter, runPairJoiner } from '../../src/sync/pairing';
import { addGroupKey, create, getSession, getVector, listActive, rotateKey, update } from '../../src/db/repo';
import { createGroup } from '../../src/db/group';
import { newDb, twoDevices } from './helpers';
import type { FamilyDB } from '../../src/db/db';
import type { Session } from '../../src/db/repo';

const FP_A = 'AA:'.repeat(31) + 'AA';
const FP_B = 'BB:'.repeat(31) + 'BB';

function sync(a: FamilyDB, sa: Session, b: FamilyDB, sb: Session, opts: { dropAfter?: number } = {}) {
  const [ca, cb] = memoryPair(opts);
  return Promise.allSettled([
    runSync({ db: a, session: sa, channel: ca, role: 'offerer', localFingerprint: FP_A, remoteFingerprint: FP_B, timeoutMs: 2000 }),
    runSync({ db: b, session: sb, channel: cb, role: 'answerer', localFingerprint: FP_B, remoteFingerprint: FP_A, timeoutMs: 2000 }),
  ]);
}

const names = async (db: FamilyDB, g: string) => (await listActive(db, g, 'tasks')).map((t) => t.title).sort();
const task = (title: string) => ({ title, assigneeId: null, dueDate: null, done: false, doneAt: null, doneBy: null, categoryId: null, note: '' });

describe('同期プロトコル', () => {
  it('認証後に双方向の差分を交換し、同じ状態になる', async () => {
    const { a, b, sa, sb } = await twoDevices();
    await create(b, sb, 'tasks', task('ゴミ出し'));
    const [ra, rb] = await sync(a, sa, b, sb);
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('fulfilled');
    expect(await getVector(a, sa.groupId)).toEqual(await getVector(b, sa.groupId));
    expect(await names(a, sa.groupId)).toEqual(['ゴミ出し']);
    expect((await listActive(b, sa.groupId, 'shoppingLists')).length).toBe(1);
    const peer = await a.peers.get([sa.groupId, sb.deviceId]);
    expect(peer?.lastResult).toBe('ok');
    expect(peer?.vector).toEqual(await getVector(b, sa.groupId));
  });

  it('大量データ (2000 件・長文メモ) も分割して同期できる', async () => {
    const { a, b, sa, sb } = await twoDevices();
    for (let i = 0; i < 2000; i++) await create(a, sa, 'tasks', task(`タスク${i}`));
    await create(a, sa, 'memos', { title: '長文', body: 'あ'.repeat(20000), categoryId: null, pinned: false });
    const [ra] = await sync(a, sa, b, sb);
    expect(ra.status).toBe('fulfilled');
    expect((await listActive(b, sa.groupId, 'tasks')).length).toBe(2000);
    expect((await listActive(b, sa.groupId, 'memos'))[0]!.body.length).toBe(20000);
  }, 60_000);

  it('グループ鍵が異なる端末とは同期しない (auth-failed)', async () => {
    const a = newDb();
    const b = newDb();
    const sa = await createGroup(a, { groupName: 'A家', memberName: 'x', memberColor: 'teal', deviceName: 'A' });
    const sbReal = await createGroup(b, { groupName: 'B家', memberName: 'y', memberColor: 'teal', deviceName: 'B' });
    // B が A のグループ ID を名乗るが鍵を持たない (別の鍵) ケース
    await addGroupKey(b, sa.groupId, 1);
    const sb = { ...sbReal, groupId: sa.groupId };
    const [ra, rb] = await sync(a, sa, b, sb);
    expect(ra.status).toBe('rejected');
    expect(((ra as PromiseRejectedResult).reason as SyncError).code).toBe('auth-failed');
    expect(rb.status).toBe('rejected');
    expect(await names(a, sa.groupId)).toEqual([]);
  });

  it('別グループの端末は different-group で拒否', async () => {
    const a = newDb();
    const b = newDb();
    const sa = await createGroup(a, { groupName: 'A家', memberName: 'x', memberColor: 'teal', deviceName: 'A' });
    const sb = await createGroup(b, { groupName: 'B家', memberName: 'y', memberColor: 'teal', deviceName: 'B' });
    const [ra] = await sync(a, sa, b, sb);
    expect(((ra as PromiseRejectedResult).reason as SyncError).code).toBe('different-group');
  });

  it('失効した端末とは同期しない', async () => {
    const { a, b, sa, sb } = await twoDevices();
    await update(a, sa, 'devices', sb.deviceId, { revoked: true });
    await rotateKey(a, sa.groupId);
    const [ra] = await sync(a, sa, b, sb);
    expect(((ra as PromiseRejectedResult).reason as SyncError).code).toBe('revoked');
  });

  it('鍵更新 (epoch) は失効していない端末へ配布される', async () => {
    const { a, b, sa, sb } = await twoDevices();
    const k2 = await rotateKey(a, sa.groupId);
    const [ra] = await sync(a, sa, b, sb);
    expect(ra.status).toBe('fulfilled');
    expect((await b.groupKeys.get([sa.groupId, 2]))?.key).toBe(k2.key);
  });

  it('途中で切断しても、再同期で欠落・重複なく復旧する', async () => {
    const { a, b, sa, sb } = await twoDevices();
    for (let i = 0; i < 300; i++) await create(a, sa, 'tasks', task(`t${i}`));
    const [r1] = await sync(a, sa, b, sb, { dropAfter: 6 });
    expect(r1.status).toBe('rejected');
    expect(((r1 as PromiseRejectedResult).reason as SyncError).code).toBe('connection-lost');
    expect((await a.peers.get([sa.groupId, sb.deviceId]))?.lastResult).toBe('error');
    const [r2] = await sync(a, sa, b, sb);
    expect(r2.status).toBe('fulfilled');
    expect((await listActive(b, sa.groupId, 'tasks')).length).toBe(300);
    expect(await getVector(a, sa.groupId)).toEqual(await getVector(b, sa.groupId));
  });
});

describe('ペアリング', () => {
  it('確認コード一致 → 鍵受け渡し → 新メンバー登録 → 初回同期', async () => {
    const a = newDb();
    const b = newDb();
    const sa = await createGroup(a, { groupName: '山田家', memberName: '母', memberColor: 'teal', deviceName: '母のiPhone' });
    await create(a, sa, 'tasks', task('宿題チェック'));
    const [ca, cb] = memoryPair();
    const sasSeen: string[] = [];
    const [ri, rj] = await Promise.allSettled([
      runPairInviter({ db: a, session: sa, channel: ca, localFingerprint: FP_A, remoteFingerprint: FP_B, confirmSas: async (s) => (sasSeen.push(s), true) }),
      runPairJoiner({
        db: b, channel: cb, localFingerprint: FP_B, remoteFingerprint: FP_A,
        confirmSas: async (s) => (sasSeen.push(s), true),
        chooseMember: async (inv) => {
          expect(inv.groupName).toBe('山田家');
          return { deviceName: '父のAndroid', memberId: null, newMember: { name: '父', color: 'blue' } };
        },
      }),
    ]);
    expect(ri.status).toBe('fulfilled');
    expect(rj.status).toBe('fulfilled');
    expect(sasSeen[0]).toMatch(/^\d{3} \d{3}$/);
    expect(sasSeen[0]).toBe(sasSeen[1]);
    const sb = (await getSession(b))!;
    expect(sb.groupId).toBe(sa.groupId);
    expect(await names(b, sa.groupId)).toEqual(['宿題チェック']);
    const members = (await listActive(b, sa.groupId, 'members')).map((m) => m.name).sort();
    expect(members).toEqual(['母', '父']);
    expect((await b.devices.get(sb.deviceId))?.name).toBe('父のAndroid');
  });

  it('確認コードが一致しないと答えたら鍵を渡さない', async () => {
    const a = newDb();
    const b = newDb();
    const sa = await createGroup(a, { groupName: '山田家', memberName: '母', memberColor: 'teal', deviceName: 'A' });
    const [ca, cb] = memoryPair();
    const [ri, rj] = await Promise.allSettled([
      runPairInviter({ db: a, session: sa, channel: ca, localFingerprint: FP_A, remoteFingerprint: FP_B, confirmSas: async () => true }),
      runPairJoiner({ db: b, channel: cb, localFingerprint: FP_B, remoteFingerprint: FP_A, confirmSas: async () => false, chooseMember: async () => { throw new Error('should not be called'); } }),
    ]);
    expect(ri.status).toBe('rejected');
    expect(rj.status).toBe('rejected');
    expect(await b.groupKeys.count()).toBe(0);
    expect(await getSession(b)).toBeNull();
  });
});
