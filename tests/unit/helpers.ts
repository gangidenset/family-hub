import 'fake-indexeddb/auto';
import { FamilyDB } from '../../src/db/db';
import { createGroup } from '../../src/db/group';
import { addGroupKey, ensureDevice, latestKey, setSession, type Session } from '../../src/db/repo';
import { create } from '../../src/db/repo';

let n = 0;
export function newDb(): FamilyDB {
  return new FamilyDB(`test-${Date.now()}-${n++}`);
}

/** グループを作成した端末 A と、同じグループに (ペアリング済みとして) 参加した端末 B */
export async function twoDevices(): Promise<{ a: FamilyDB; b: FamilyDB; sa: Session; sb: Session }> {
  const a = newDb();
  const b = newDb();
  const sa = await createGroup(a, { groupName: 'テスト家', memberName: '母', memberColor: 'teal', deviceName: 'A' });
  const devB = await ensureDevice(b);
  const key = (await latestKey(a, sa.groupId))!;
  await addGroupKey(b, sa.groupId, key.epoch, key.key);
  const memberB = crypto.randomUUID();
  await create(a, sa, 'members', { name: '父', color: 'blue', role: 'adult' }, memberB);
  await create(a, sa, 'devices', { name: 'B', memberId: memberB, revoked: false }, devB.deviceId);
  await setSession(b, sa.groupId, memberB);
  return { a, b, sa, sb: { groupId: sa.groupId, memberId: memberB, deviceId: devB.deviceId } };
}
