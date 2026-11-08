import { describe, expect, it } from 'vitest';
import { create, getVector, listActive, opsSince, softDelete, update } from '../../src/db/repo';
import { applyOps, InvalidDataError } from '../../src/sync/merge';
import { formatHlc } from '../../src/db/hlc';
import { twoDevices } from './helpers';
import type { FamilyDB } from '../../src/db/db';

async function exchange(x: FamilyDB, y: FamilyDB, groupId: string) {
  const ox = await opsSince(x, groupId, await getVector(y, groupId));
  const oy = await opsSince(y, groupId, await getVector(x, groupId));
  await applyOps(y, groupId, ox);
  await applyOps(x, groupId, oy);
}

async function snapshot(db: FamilyDB, groupId: string) {
  const items = await db.shoppingItems.where('groupId').equals(groupId).toArray();
  return items.map(({ clock: _c, ...r }) => r).sort((p, q) => p.id.localeCompare(q.id));
}

const item = (listId: string, name: string) => ({
  listId, name, quantity: 1, unit: '', categoryId: null, note: '', checked: false, checkedAt: null, checkedBy: null, sortKey: 'i',
});

describe('Repository', () => {
  it('作成・更新で操作ログが連番で記録される', async () => {
    const { a, sa } = await twoDevices();
    const [list] = await listActive(a, sa.groupId, 'shoppingLists');
    const id = await create(a, sa, 'shoppingItems', item(list!.id, '牛乳'));
    await update(a, sa, 'shoppingItems', id, { quantity: 2 });
    const v = await getVector(a, sa.groupId);
    const ops = await opsSince(a, sa.groupId, {});
    expect(ops.map((o) => o.seq)).toEqual(Array.from({ length: v[sa.deviceId]! }, (_, i) => i + 1));
    expect((await a.shoppingItems.get(id))!.quantity).toBe(2);
  });

  it('不正な値は保存しない (バリデーション)', async () => {
    const { a, sa } = await twoDevices();
    await expect(create(a, sa, 'tasks', { title: '', assigneeId: null, dueDate: null, done: false, doneAt: null, doneBy: null, categoryId: null, note: '' })).rejects.toThrow();
    await expect(create(a, sa, 'memos', { title: 'a\u0000', body: '', categoryId: null, pinned: false })).rejects.toThrow();
    await expect(create(a, sa, 'memos', { title: 'x'.repeat(201), body: '', categoryId: null, pinned: false })).rejects.toThrow();
  });
});

describe('同期マージ', () => {
  it('双方の変更が交換後に一致する', async () => {
    const { a, b, sa, sb } = await twoDevices();
    await exchange(a, b, sa.groupId);
    const [list] = await listActive(b, sb.groupId, 'shoppingLists');
    await create(a, sa, 'shoppingItems', item(list!.id, '卵'));
    await create(b, sb, 'shoppingItems', item(list!.id, 'パン'));
    await exchange(a, b, sa.groupId);
    expect(await snapshot(a, sa.groupId)).toEqual(await snapshot(b, sa.groupId));
    expect((await snapshot(a, sa.groupId)).map((r) => r.name).sort()).toEqual(['パン', '卵']);
  });

  it('別フィールドの同時編集は両方反映、同一フィールドは同じ値に収束', async () => {
    const { a, b, sa, sb } = await twoDevices();
    await exchange(a, b, sa.groupId);
    const [list] = await listActive(a, sa.groupId, 'shoppingLists');
    const id = await create(a, sa, 'shoppingItems', item(list!.id, '牛乳'));
    await exchange(a, b, sa.groupId);
    await update(a, sa, 'shoppingItems', id, { quantity: 3, name: '牛乳(低脂肪)' });
    await update(b, sb, 'shoppingItems', id, { note: '2本', name: '豆乳' });
    await exchange(a, b, sa.groupId);
    const ra = (await a.shoppingItems.get(id))!;
    const rb = (await b.shoppingItems.get(id))!;
    expect(ra.quantity).toBe(3);
    expect(ra.note).toBe('2本');
    expect(ra.name).toBe(rb.name);
    expect(await snapshot(a, sa.groupId)).toEqual(await snapshot(b, sa.groupId));
  });

  it('削除はトゥームストーンとして伝わる', async () => {
    const { a, b, sa } = await twoDevices();
    const [list] = await listActive(a, sa.groupId, 'shoppingLists');
    const id = await create(a, sa, 'shoppingItems', item(list!.id, '卵'));
    await exchange(a, b, sa.groupId);
    await softDelete(a, sa, 'shoppingItems', id);
    await exchange(a, b, sa.groupId);
    expect((await b.shoppingItems.get(id))!.deleted).toBe(true);
    expect(await listActive(b, sa.groupId, 'shoppingItems')).toHaveLength(0);
  });

  it('同じ操作を 2 回適用しても結果は変わらない (冪等)', async () => {
    const { a, b, sa } = await twoDevices();
    const ops = await opsSince(a, sa.groupId, {});
    const r1 = await applyOps(b, sa.groupId, ops);
    const r2 = await applyOps(b, sa.groupId, ops);
    expect(r1.applied).toBe(ops.length);
    expect(r2.applied).toBe(0);
  });

  it('メモ本文の同時編集では負けた側の値を競合として保存する', async () => {
    const { a, b, sa, sb } = await twoDevices();
    const id = await create(a, sa, 'memos', { title: '持ち物', body: '体操服', categoryId: null, pinned: false });
    await exchange(a, b, sa.groupId);
    await update(a, sa, 'memos', id, { body: '体操服、上履き' });
    await update(b, sb, 'memos', id, { body: '体操服、水筒' });
    await exchange(a, b, sa.groupId);
    const ma = (await a.memos.get(id))!;
    const mb = (await b.memos.get(id))!;
    expect(ma.body).toBe(mb.body);
    const ca = await a.conflicts.toArray();
    const cb = await b.conflicts.toArray();
    expect(ca).toHaveLength(1);
    expect(cb).toHaveLength(1);
    const loser = ma.body === '体操服、上履き' ? '体操服、水筒' : '体操服、上履き';
    expect(ca[0]!.losingValue).toBe(loser);
    expect(cb[0]!.losingValue).toBe(loser);
  });

  it('順番どおりの編集 (相手の変更を見てから編集) は競合にしない', async () => {
    const { a, b, sa, sb } = await twoDevices();
    const id = await create(a, sa, 'memos', { title: 't', body: '1', categoryId: null, pinned: false });
    await exchange(a, b, sa.groupId);
    await update(b, sb, 'memos', id, { body: '2' });
    await exchange(a, b, sa.groupId);
    await update(a, sa, 'memos', id, { body: '3' });
    await update(a, sa, 'memos', id, { body: '4' });
    await exchange(a, b, sa.groupId);
    expect((await b.memos.get(id))!.body).toBe('4');
    expect(await a.conflicts.count()).toBe(0);
    expect(await b.conflicts.count()).toBe(0);
  });

  it('不正な操作・別グループの操作は 1 件も適用しない', async () => {
    const { a, b, sa } = await twoDevices();
    const ops = await opsSince(a, sa.groupId, {});
    const bad = [...ops, { ...ops[0]!, seq: 999, patch: { name: '<script>'.repeat(100) } }];
    await expect(applyOps(b, sa.groupId, bad)).rejects.toThrow(InvalidDataError);
    await expect(applyOps(b, crypto.randomUUID(), ops)).rejects.toThrow(InvalidDataError);
    const proto = JSON.parse(JSON.stringify(ops[0]).replace('"patch":{', '"patch":{"__proto__":{"x":1},'));
    await expect(applyOps(b, sa.groupId, [proto])).rejects.toThrow(InvalidDataError);
    expect(await b.oplog.count()).toBe(0);
  });

  it('時計が大きく未来にずれた端末の操作は拒否する', async () => {
    const { a, b, sa } = await twoDevices();
    const ops = await opsSince(a, sa.groupId, {});
    const future = ops.slice(0, 1).map((o) => ({ ...o, hlc: formatHlc(Date.now() + 3 * 86400000, 0, o.deviceId) }));
    await expect(applyOps(b, sa.groupId, future)).rejects.toThrow('clock-drift');
  });
});
